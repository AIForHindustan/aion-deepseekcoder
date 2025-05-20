import * as vscode from 'vscode';
import { ProjectScanner } from './projectScanner.js';
import { ChatViewProvider } from './chatView.js';

export function activate(context: vscode.ExtensionContext) {
    console.log('AION EXTENSION ACTIVATED!');
    vscode.window.showInformationMessage('AION is now active!');

    const config = vscode.workspace.getConfiguration('aion');
    const apiKey = config.get<string>('openrouterApiKey');

    if (!apiKey) {
        vscode.window.showErrorMessage('OpenRouter API key not found in settings!');
        return;
    }

    // Register ChatViewProvider
    const chatProvider = new ChatViewProvider(context, apiKey);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            chatProvider
        )
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('aion.askDeepseek', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor!');
                return;
            }

            const scanner = new ProjectScanner();
            const structure = await scanner.scanWorkspace();
            vscode.window.showInformationMessage(`Project scanned: ${structure.allFiles.length} files found`);
        }),

        vscode.commands.registerCommand('aion.startChat', () => {
            vscode.commands.executeCommand('workbench.view.extension.aion.chatView');
        })
    );
}

export function deactivate() { }