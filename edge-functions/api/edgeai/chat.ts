/**
 * EdgeOne Pages Edge Function for AI Chat
 *
 * This function intercepts /api/chat requests when deployed to EdgeOne Pages
 * and uses the built-in Edge AI service (DeepSeek models).
 *
 *
 * Documentation: https://pages.edgeone.ai/document/edge-ai
 */

import { getEdgeAISystemPrompt } from "../../system-prompts"

// EdgeOne Pages global AI object
declare const AI: {
    chatCompletions(options: {
        model: string
        messages: Array<{ role: string; content: string }>
        stream?: boolean
    }): Promise<ReadableStream<Uint8Array>>
}

interface EdgeFunctionContext {
    request: Request
    env: Record<string, string>
    next: () => Promise<Response>
}

interface UIMessage {
    role: "user" | "assistant" | "system"
    content?: string
    parts?: Array<{
        type: string
        text?: string
        toolName?: string
        input?: Record<string, unknown>
    }>
}

interface ParsedToolCall {
    tool: "display_diagram" | "edit_diagram"
    xml?: string
    operations?: Array<{
        type: "update" | "add" | "delete"
        cell_id: string
        new_xml?: string
    }>
}

// Handle CORS preflight requests
export async function onRequestOptions(): Promise<Response> {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers":
                "Content-Type, Authorization, X-Access-Code, X-AI-Provider, X-AI-Model, X-AI-Base-URL, X-AI-API-Key, X-Minimal-Style",
            "Access-Control-Max-Age": "86400",
        },
    })
}

// Main chat handler
export async function onRequestPost({
    request,
    env,
}: EdgeFunctionContext): Promise<Response> {
    request.headers.delete("accept-encoding")

    const corsHeaders: Record<string, string> = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
            "Content-Type, Authorization, X-Access-Code, X-AI-Provider, X-AI-Model, X-AI-Base-URL, X-AI-API-Key, X-Minimal-Style",
    }

    try {
        // Read body as text first, then parse (avoids Request reuse issues)
        const bodyText = await request.text()
        const body = JSON.parse(bodyText) as {
            messages: UIMessage[]
            xml?: string
            previousXml?: string
        }
        const { messages, xml, previousXml } = body

        // Get model from header or env, default to deepseek-v3
        const modelId =
            request.headers.get("X-AI-Model") ||
            env.AI_MODEL ||
            "@tx/deepseek-ai/deepseek-v32"

        // Build system prompt (without XML context - that's added separately in convertToAIMessages)
        const systemPrompt = getEdgeAISystemPrompt(modelId)

        // Convert messages to Edge AI format with XML context
        const aiMessages = convertToAIMessages(
            messages,
            systemPrompt,
            xml,
            previousXml,
        )

        console.log(`[Edge AI] Using model: ${modelId}`)
        console.log(`[Edge AI] Messages count: ${aiMessages.length}`)

        // Call EdgeOne Edge AI with streaming
        console.log(`[Edge AI] Calling AI.chatCompletions... ${Date.now()}`)
        const aiResponse = await AI.chatCompletions({
            model: modelId,
            messages: aiMessages,
            stream: true,
        })
        console.log(`[Edge AI] AI.chatCompletions returned ${Date.now()}`)

        // Transform to AI SDK UI stream format
        const transformedStream = transformToUIStream(aiResponse)

        return new Response(transformedStream, {
            headers: {
                ...corsHeaders,
                "Content-Type": "text/event-stream; charset=utf-8",
                "Content-Encoding": "identity", // Disable compression for streaming
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "x-vercel-ai-ui-message-stream": "v1",
            },
        })
    } catch (error) {
        console.error("[Edge AI] Error:", error)

        // Return error as a valid AI SDK stream so frontend doesn't crash
        const encoder = new TextEncoder()
        const errorMessage =
            error instanceof Error ? error.message : "Edge AI service error"
        const isRateLimit =
            errorMessage.includes("limit") || errorMessage.includes("quota")

        const msg = isRateLimit
            ? `LimitError: ${errorMessage}`
            : `Error: ${errorMessage}`

        const errorTextId = `error_${Date.now()}`
        const errorStream = new ReadableStream({
            start(controller) {
                controller.enqueue(
                    encoder.encode(
                        `data: ${JSON.stringify({ type: "start" })}\n\n`,
                    ),
                )
                controller.enqueue(
                    encoder.encode(
                        `data: ${JSON.stringify({ type: "text-start", id: errorTextId })}\n\n`,
                    ),
                )
                controller.enqueue(
                    encoder.encode(
                        `data: ${JSON.stringify({ type: "text-delta", id: errorTextId, delta: msg })}\n\n`,
                    ),
                )
                controller.enqueue(
                    encoder.encode(
                        `data: ${JSON.stringify({ type: "text-end", id: errorTextId })}\n\n`,
                    ),
                )
                controller.enqueue(
                    encoder.encode(
                        `data: ${JSON.stringify({ type: "finish", finishReason: "error" })}\n\n`,
                    ),
                )
                controller.close()
            },
        })

        return new Response(errorStream, {
            headers: {
                ...corsHeaders,
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "x-vercel-ai-ui-message-stream": "v1",
            },
        })
    }
}

/**
 * Convert UI messages to Edge AI format
 * Adapted from Next.js route.ts convertToModelMessages + enhancedMessages logic
 */
function convertToAIMessages(
    messages: UIMessage[],
    systemPrompt: string,
    xml?: string,
    previousXml?: string,
): Array<{ role: string; content: string }> {
    // System messages structure matching route.ts:
    // - Message 1: Instructions (static prompt)
    // - Message 2: Diagram XML context (current + previous)
    const systemMessages: Array<{ role: string; content: string }> = [
        { role: "system", content: systemPrompt },
    ]

    // Add XML context as separate system message (matching route.ts format)
    const xmlContext = buildXmlContextMessage(xml, previousXml)
    if (xmlContext) {
        systemMessages.push({ role: "system", content: xmlContext })
    }

    const aiMessages: Array<{ role: string; content: string }> = [
        ...systemMessages,
    ]

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        const isLastMessage = i === messages.length - 1

        if (msg.role === "user") {
            // Handle both formats: parts array or direct content
            let content = ""
            if (msg.parts && Array.isArray(msg.parts)) {
                const textPart = msg.parts.find((p) => p.type === "text")
                if (textPart?.text) {
                    content = textPart.text
                }
            } else if (msg.content) {
                content =
                    typeof msg.content === "string"
                        ? msg.content
                        : JSON.stringify(msg.content)
            }

            if (content) {
                // Format user input matching route.ts style for the last message
                if (isLastMessage) {
                    content = `User input:\n"""md\n${content}\n"""`
                }
                aiMessages.push({ role: "user", content })
            }
        } else if (msg.role === "assistant") {
            let content = ""
            if (msg.parts && Array.isArray(msg.parts)) {
                for (const part of msg.parts) {
                    if (part.type === "text" && part.text) {
                        content += part.text
                    } else if (part.type === "tool-invocation") {
                        // Replace historical tool XML with placeholder to reduce tokens
                        // Matching route.ts replaceHistoricalToolInputs behavior
                        if (part.toolName === "display_diagram") {
                            content += JSON.stringify({
                                tool: "display_diagram",
                                xml: "[XML content replaced - see current diagram XML in system context]",
                            })
                        } else if (part.toolName === "edit_diagram") {
                            // Keep edit operations as they're usually small
                            content += JSON.stringify({
                                tool: "edit_diagram",
                                operations: part.input?.operations || [],
                            })
                        }
                    }
                }
            } else if (msg.content) {
                content =
                    typeof msg.content === "string"
                        ? msg.content
                        : JSON.stringify(msg.content)
            }

            // Filter out empty assistant messages (matching route.ts filter logic)
            if (content && content.trim()) {
                aiMessages.push({ role: "assistant", content })
            }
        }
    }

    return aiMessages
}

/**
 * Build XML context message matching route.ts format
 * This is the SOURCE OF TRUTH message that tells the model about current diagram state
 */
function buildXmlContextMessage(
    xml?: string,
    previousXml?: string,
): string | null {
    if (!xml && !previousXml) return null

    let content = ""

    if (previousXml) {
        content += `Previous diagram XML (before user's last message):\n"""xml\n${previousXml}\n"""\n\n`
    }

    if (xml) {
        content += `Current diagram XML (AUTHORITATIVE - the source of truth):\n"""xml\n${xml}\n"""\n\n`
        content += `IMPORTANT: The "Current diagram XML" is the SINGLE SOURCE OF TRUTH for what's on the canvas right now. The user can manually add, delete, or modify shapes directly in draw.io. Always count and describe elements based on the CURRENT XML, not on what you previously generated. If both previous and current XML are shown, compare them to understand what the user changed. When using edit_diagram, COPY search patterns exactly from the CURRENT XML - attribute order matters!`
    }

    return content
}

/**
 * Transform Edge AI SSE stream to AI SDK UI message stream format (v5)
 *
 * AI SDK v5 UI stream format uses SSE with JSON objects:
 * - {"type":"reasoning-start","id":"..."} for reasoning start (DeepSeek-R1)
 * - {"type":"reasoning-delta","id":"...","delta":"..."} for reasoning content
 * - {"type":"reasoning-end","id":"..."} for reasoning end
 * - {"type":"text-start","id":"..."} for text start
 * - {"type":"text-delta","id":"...","delta":"..."} for text content
 * - {"type":"text-end","id":"..."} for text end
 * - {"type":"tool-input-start","toolCallId":"...","toolName":"..."} for tool call start
 * - {"type":"tool-input-delta","toolCallId":"...","inputTextDelta":"..."} for tool input streaming
 * - {"type":"tool-input-available","toolCallId":"...","toolName":"...","input":{...}} for complete tool input
 * - {"type":"finish","finishReason":"stop"} for end of stream
 *
 * DeepSeek-R1 returns reasoning_content in delta for thinking process.
 * DeepSeek-V3 returns content directly without reasoning.
 *
 * KEY: We use a pull-based ReadableStream that actively reads from the source stream.
 * This ensures data flows immediately without waiting for the entire upstream to complete.
 */
function transformToUIStream(
    edgeAIStream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
    let fullContent = ""
    let pendingBuffer = "" // Buffer for content that might be tool call start
    let toolCallJsonBuffer = "" // Accumulates the tool call JSON once detected
    const toolCallId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const textId = `text_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const reasoningId = `reasoning_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    let sseBuffer = ""
    let textStarted = false
    let reasoningStarted = false
    let toolCallStarted = false // Whether we've sent tool-input-start
    let detectedToolName: "display_diagram" | "edit_diagram" | null = null

    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    // Helper to create SSE message bytes
    const createSSE = (data: Record<string, unknown>): Uint8Array => {
        return encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
    }

    // Detect tool name from partial JSON
    function detectToolName(
        content: string,
    ): "display_diagram" | "edit_diagram" | null {
        const match = content.match(
            /"tool"\s*:\s*"(display_diagram|edit_diagram)"/,
        )
        if (match) {
            return match[1] as "display_diagram" | "edit_diagram"
        }
        if (content.includes('"tool"') && content.includes("display_diagram")) {
            return "display_diagram"
        }
        if (content.includes('"tool"') && content.includes("edit_diagram")) {
            return "edit_diagram"
        }
        return null
    }

    // Process a single SSE data line and return chunks to enqueue
    function processDataLine(data: string): Uint8Array[] {
        const chunks: Uint8Array[] = []

        if (data === "[DONE]") return chunks

        try {
            const parsed = JSON.parse(data) as {
                choices?: Array<{
                    delta?: {
                        content?: string
                        reasoning_content?: string
                    }
                }>
            }

            const delta = parsed.choices?.[0]?.delta
            if (!delta) return chunks

            // Handle reasoning_content (DeepSeek-R1 thinking process)
            if (delta.reasoning_content) {
                const text = delta.reasoning_content
                if (text && text.trim()) {
                    if (!reasoningStarted) {
                        chunks.push(
                            createSSE({
                                type: "reasoning-start",
                                id: reasoningId,
                            }),
                        )
                        reasoningStarted = true
                    }
                    chunks.push(
                        createSSE({
                            type: "reasoning-delta",
                            id: reasoningId,
                            delta: text,
                        }),
                    )
                }
            }

            // Handle regular content (final answer)
            if (delta.content) {
                fullContent += delta.content

                // If tool call already started, accumulate and stream delta
                if (toolCallStarted) {
                    toolCallJsonBuffer += delta.content
                    chunks.push(
                        createSSE({
                            type: "tool-input-delta",
                            toolCallId,
                            inputTextDelta: delta.content,
                        }),
                    )
                    return chunks
                }

                // Add new content to pending buffer
                pendingBuffer += delta.content

                // Look for tool call pattern: {"tool"
                const toolJsonStart = pendingBuffer.indexOf('{"tool"')

                if (toolJsonStart !== -1) {
                    // Found potential tool call start
                    const afterToolStart = pendingBuffer.slice(toolJsonStart)
                    const toolName = detectToolName(afterToolStart)

                    if (toolName) {
                        // Confirmed tool call - stream text before it, then start tool call
                        console.log(`[Edge AI] Detected tool call: ${toolName}`)
                        if (toolJsonStart > 0) {
                            const textBefore = pendingBuffer.slice(
                                0,
                                toolJsonStart,
                            )
                            if (textBefore.trim()) {
                                if (!textStarted) {
                                    chunks.push(
                                        createSSE({
                                            type: "text-start",
                                            id: textId,
                                        }),
                                    )
                                    textStarted = true
                                }
                                chunks.push(
                                    createSSE({
                                        type: "text-delta",
                                        id: textId,
                                        delta: textBefore,
                                    }),
                                )
                            }
                        }

                        // End text stream if started
                        if (textStarted) {
                            chunks.push(
                                createSSE({ type: "text-end", id: textId }),
                            )
                            textStarted = false
                        }

                        // Start tool call
                        toolCallStarted = true
                        detectedToolName = toolName
                        chunks.push(
                            createSSE({
                                type: "tool-input-start",
                                toolCallId,
                                toolName,
                            }),
                        )

                        toolCallJsonBuffer = afterToolStart
                        chunks.push(
                            createSSE({
                                type: "tool-input-delta",
                                toolCallId,
                                inputTextDelta: afterToolStart,
                            }),
                        )
                        pendingBuffer = ""
                    }
                    // If tool name not detected yet, keep buffering
                } else {
                    // No tool call pattern found - stream safe content immediately
                    const partialPatterns = [
                        "{",
                        '{"',
                        '{"t',
                        '{"to',
                        '{"too',
                        '{"tool',
                    ]
                    let keepFromIndex = pendingBuffer.length

                    for (const pattern of partialPatterns) {
                        if (pendingBuffer.endsWith(pattern)) {
                            keepFromIndex =
                                pendingBuffer.length - pattern.length
                            break
                        }
                    }

                    if (keepFromIndex > 0) {
                        const safeText = pendingBuffer.slice(0, keepFromIndex)
                        if (safeText.trim()) {
                            if (!textStarted) {
                                chunks.push(
                                    createSSE({
                                        type: "text-start",
                                        id: textId,
                                    }),
                                )
                                textStarted = true
                            }
                            chunks.push(
                                createSSE({
                                    type: "text-delta",
                                    id: textId,
                                    delta: safeText,
                                }),
                            )
                        }
                        pendingBuffer = pendingBuffer.slice(keepFromIndex)
                    }
                }
            }
        } catch {
            // Skip invalid JSON
        }

        return chunks
    }

    // Finalize the stream
    function finalizeStream(): Uint8Array[] {
        const chunks: Uint8Array[] = []

        console.log("[Edge AI] Stream finalizing")

        // End reasoning stream if started
        if (reasoningStarted) {
            chunks.push(createSSE({ type: "reasoning-end", id: reasoningId }))
        }

        // Finalize tool call if one was started
        if (toolCallStarted && detectedToolName) {
            const toolCall = parseToolCall(toolCallJsonBuffer)

            if (toolCall) {
                chunks.push(
                    createSSE({
                        type: "tool-input-available",
                        toolCallId,
                        toolName: detectedToolName,
                        input:
                            detectedToolName === "display_diagram"
                                ? { xml: toolCall.xml }
                                : { operations: toolCall.operations },
                    }),
                )
            } else {
                chunks.push(
                    createSSE({
                        type: "tool-input-available",
                        toolCallId,
                        toolName: detectedToolName,
                        input:
                            detectedToolName === "display_diagram"
                                ? { xml: "" }
                                : { operations: [] },
                    }),
                )
            }
        } else if (!textStarted && fullContent) {
            // No tool call and no text was streamed - send all as text
            if (fullContent.trim()) {
                chunks.push(createSSE({ type: "text-start", id: textId }))
                chunks.push(
                    createSSE({
                        type: "text-delta",
                        id: textId,
                        delta: fullContent,
                    }),
                )
                chunks.push(createSSE({ type: "text-end", id: textId }))
            }
        } else if (pendingBuffer && !toolCallStarted) {
            // Flush remaining pending buffer as text
            if (pendingBuffer.trim()) {
                if (!textStarted) {
                    chunks.push(createSSE({ type: "text-start", id: textId }))
                    textStarted = true
                }
                chunks.push(
                    createSSE({
                        type: "text-delta",
                        id: textId,
                        delta: pendingBuffer,
                    }),
                )
            }
            if (textStarted) {
                chunks.push(createSSE({ type: "text-end", id: textId }))
            }
        } else if (textStarted) {
            chunks.push(createSSE({ type: "text-end", id: textId }))
        }

        chunks.push(createSSE({ type: "finish", finishReason: "stop" }))
        return chunks
    }

    // Get reader from source stream
    const reader = edgeAIStream.getReader()

    // Create output stream - use start() to immediately begin processing
    // This ensures data flows as soon as the Response is created
    return new ReadableStream<Uint8Array>({
        start(controller) {
            // Send start event immediately
            controller.enqueue(createSSE({ type: "start" }))
            console.log("[Edge AI] Stream started, beginning async read loop")

            // Start async read loop (not awaited - runs in background)
            ;(async () => {
                try {
                    while (true) {
                        const { done, value } = await reader.read()

                        if (done) {
                            // Stream ended - finalize and close
                            const finalChunks = finalizeStream()
                            for (const chunk of finalChunks) {
                                controller.enqueue(chunk)
                            }
                            controller.close()
                            console.log("[Edge AI] Stream closed")
                            return
                        }

                        // Process the chunk immediately
                        const chunkStr = decoder.decode(value, { stream: true })
                        sseBuffer += chunkStr

                        const lines = sseBuffer.split("\n")
                        sseBuffer = lines.pop() || ""

                        for (const line of lines) {
                            const trimmedLine = line.trim()
                            if (
                                !trimmedLine ||
                                !trimmedLine.startsWith("data:")
                            )
                                continue

                            const data = trimmedLine.slice(5).trim()
                            const outputChunks = processDataLine(data)

                            for (const chunk of outputChunks) {
                                controller.enqueue(chunk)
                            }
                        }
                    }
                } catch (error) {
                    console.error("[Edge AI] Stream read error:", error)
                    controller.error(error)
                }
            })()
        },

        cancel() {
            reader.cancel()
        },
    })
}

/**
 * Parse tool call from accumulated content
 * Handles cases where AI doesn't properly escape quotes in XML
 */
function parseToolCall(content: string): ParsedToolCall | null {
    try {
        const jsonMatch = content.match(/\{[\s\S]*"tool"[\s\S]*\}/)
        if (!jsonMatch) return null
        return JSON.parse(jsonMatch[0]) as ParsedToolCall
    } catch {
        // JSON.parse failed - likely because quotes in XML aren't escaped
        // Try to extract XML manually
        if (content.includes("display_diagram")) {
            // Find the start of xml value: "xml": "
            const xmlStartMatch = content.match(/"xml"\s*:\s*"/)
            if (xmlStartMatch && xmlStartMatch.index !== undefined) {
                const xmlStart = xmlStartMatch.index + xmlStartMatch[0].length
                // Find the end - look for "} or just } at the end
                // The XML content is everything from xmlStart to the last }
                let xmlEnd = content.lastIndexOf('"}')
                if (xmlEnd === -1 || xmlEnd < xmlStart) {
                    xmlEnd = content.lastIndexOf("}")
                }
                if (xmlEnd > xmlStart) {
                    let xml = content.slice(xmlStart, xmlEnd)
                    // Remove trailing quote if present
                    if (xml.endsWith('"')) {
                        xml = xml.slice(0, -1)
                    }
                    // Unescape any escaped characters
                    xml = xml
                        .replace(/\\"/g, '"')
                        .replace(/\\n/g, "\n")
                        .replace(/\\\\/g, "\\")
                    if (xml.trim()) {
                        return {
                            tool: "display_diagram",
                            xml: xml,
                        }
                    }
                }
            }
        }
        if (content.includes("edit_diagram")) {
            // For edit_diagram, try to extract operations array
            const opsMatch = content.match(/"operations"\s*:\s*(\[[\s\S]*?\])/)
            if (opsMatch) {
                try {
                    const operations = JSON.parse(opsMatch[1])
                    return {
                        tool: "edit_diagram",
                        operations,
                    }
                } catch {
                    // Failed to parse operations
                }
            }
        }
        return null
    }
}
