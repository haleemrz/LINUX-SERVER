/**
 * OllamaBridge.js
 * 
 * Secure local-first connector for Ollama running on localhost.
 * This is the intelligence core that powers Intent Discovery, Dynamic Selection, and RAG capabilities.
 * Designed to gracefully fail and fallback if Ollama is not running.
 */

const http = require('http');

class OllamaBridge {
    constructor(host = '127.0.0.1', port = 11434, defaultModel = 'gemma4:31b-cloud') {
        this.host = host;
        this.port = port;
        this.defaultModel = defaultModel; // gemma4:31b-cloud via ollama proxy
    }

    /**
     * Checks if the local Ollama instance is alive and reachable.
     */
    async ping() {
        return new Promise((resolve) => {
            const req = http.request({
                hostname: this.host,
                port: this.port,
                path: '/',
                method: 'GET',
                timeout: 3000
            }, (res) => {
                resolve(res.statusCode === 200);
            });

            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
        });
    }

    /**
     * Sends a generation request to the local Ollama model.
     * @param {string} prompt The text prompt
     * @param {string} system Prompt system instructions (optional)
     * @param {string} model Model name to override default (optional)
     */
    async generate(prompt, system = '', model = null) {
        return new Promise((resolve, reject) => {
            const payload = JSON.stringify({
                model: model || this.defaultModel,
                prompt: prompt,
                system: system,
                stream: false
            });

            const req = http.request({
                hostname: this.host,
                port: this.port,
                path: '/api/generate',
                method: 'POST',
                timeout: 600000, // 10 minutes for slow cloud models / large prompts
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            }, (res) => {
                let chunks = '';
                res.on('data', (d) => chunks += d);
                res.on('end', () => {
                    console.log(`[OllamaBridge] Response status: ${res.statusCode}, body length: ${chunks.length}`);
                    if (res.statusCode === 200) {
                        try {
                            const data = JSON.parse(chunks);
                            resolve(data.response);
                        } catch (e) {
                            reject(new Error("Failed to parse Ollama response: " + chunks.substring(0, 300)));
                        }
                    } else {
                        reject(new Error(`Ollama Error: ${res.statusCode} - ${chunks.substring(0, 500)}`));
                    }
                });
            });

            req.on('timeout', () => { req.destroy(); reject(new Error("Ollama request timed out after 600s (10m)")); });
            req.on('error', (e) => reject(new Error("Ollama connection failed: " + e.message)));
            req.write(payload);
            req.end();
        });
    }

    /**
     * Analyzes a newly recorded Workflow and tries to deduce the user's intent.
     * E.g., translates "click A -> input B -> click C" into "Login form submission"
     */
    async analyzeWorkflowIntent(workflowSteps) {
        const isAlive = await this.ping();
        if (!isAlive) {
            console.warn("[OllamaBridge] Ollama is offline. Skipping LLM intent analysis.");
            return { fallbackMode: true, summary: "Auto-saved Workflow (Ollama Offline)" };
        }

        const simplifiedSteps = workflowSteps.map((s, idx) => {
            let desc = `${idx + 1}. [${s.type.toUpperCase()}] target: ${s.meta?.tagName || 'UNKNOWN'}`;
            if (s.actionValue) desc += ` | value: "${s.actionValue}"`;
            if (s.meta?.innerText) desc += ` | text: "${s.meta.innerText.substring(0, 30)}"`;
            return desc;
        }).join('\n');

        const systemPrompt = `You are a precise data-labeling AI specialized in web automation. 
Analyze the following recorded browser steps.
Deduce exactly what the user was trying to accomplish.
Keep it extremely brief, just 1-3 sentences. Identify the core intent.
Output ONLY the summary text, nothing else. No formatting.`;

        try {
            const response = await this.generate(`Steps:\n${simplifiedSteps}`, systemPrompt);
            return {
                fallbackMode: false,
                summary: response.trim()
            };
        } catch (e) {
            console.error("[OllamaBridge] Workflow analysis failed:", e);
            return { fallbackMode: true, summary: "Auto-saved Workflow (Analysis Failed)" };
        }
    }
}

module.exports = OllamaBridge;
