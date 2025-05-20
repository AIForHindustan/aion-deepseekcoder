import axios from 'axios';
import * as vscode from 'vscode';

export class DeepSeekAPI {
    private static readonly BASE_URL = 'https://api.openrouter.ai/api/v1';
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    async getCompletion(context: string, maxTokens: number = 1000): Promise<string> {
        try {
            const response = await axios.post(`${DeepSeekAPI.BASE_URL}/chat/completions`, {
                model: "deepseek/deepseek-chat",
                messages: [{
                    role: "user",
                    content: context
                }],
                max_tokens: maxTokens,
                temperature: 0.7
            }, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'HTTP-Referer': 'https://github.com/AIForHindustan/aion-deepseekcoder',
                    'X-Title': 'AION DeepSeek',
                    'X-OpenRouter-Client': 'aion-deepseekcoder'
                }
            });

            return response.data?.choices?.[0]?.message?.content || '';
        } catch (error) {
            vscode.window.showErrorMessage(`DeepSeek API Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return '';
        }
    }
}