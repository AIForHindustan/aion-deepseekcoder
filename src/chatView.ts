import * as vscode from 'vscode';
import { DeepSeekAPI } from './deepseekapi.js';
import { ContextManager } from './contextManager.js';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'aion.chatView';
    private _view?: vscode.WebviewView;
    private _contextManager = new ContextManager();
    private _api: DeepSeekAPI;

    constructor(context: vscode.ExtensionContext, apiKey: string) {
        this._api = new DeepSeekAPI(apiKey);
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getWebviewContent();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.type === 'query') {
                const activeEditor = vscode.window.activeTextEditor;
                let context = '';

                if (activeEditor) {
                    const contextResult = await this._contextManager.createContextForFile(
                        activeEditor.document.fileName
                    );
                    context = this._contextManager.formatContextForAPI(contextResult);
                }

                const fullPrompt = `${context}\n\nUser Query: ${message.text}`;
                const response = await this._api.getCompletion(fullPrompt);

                this._view?.webview.postMessage({
                    type: 'response',
                    text: response,
                    isFinal: true
                });
            }
        });
    }

    private _getWebviewContent(): string {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>DeepSeek Chat</title>
                <style>
                    body { padding: 10px; font-family: var(--vscode-font-family); }
                    #chat-container { height: 80vh; overflow-y: auto; }
                    .message { margin: 10px 0; padding: 8px; border-radius: 4px; }
                    .user { background: var(--vscode-input-background); }
                    .bot { background: var(--vscode-editor-background); }
                    #input-container { position: fixed; bottom: 10px; width: 95%; }
                    textarea { width: 100%; padding: 8px; }
                    button { margin-top: 5px; float: right; }
                </style>
            </head>
            <body>
                <div id="chat-container"></div>
                <div id="input-container">
                    <textarea id="input" placeholder="Ask DeepSeek..."></textarea>
                    <button onclick="sendQuery()">Send</button>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    const chatContainer = document.getElementById('chat-container');
                    const input = document.getElementById('input');

                    function sendQuery() {
                        const text = input.value.trim();
                        if (!text) return;
                        
                        chatContainer.innerHTML += \`
                            <div class="message user">
                                <strong>You:</strong><br>\${text}
                            </div>\`;
                        
                        vscode.postMessage({
                            type: 'query',
                            text: text
                        });
                        
                        input.value = '';
                    }

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'response') {
                            chatContainer.innerHTML += \`
                                <div class="message bot">
                                    <strong>DeepSeek:</strong><br>\${message.text}
                                </div>\`;
                            chatContainer.scrollTop = chatContainer.scrollHeight;
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }
}