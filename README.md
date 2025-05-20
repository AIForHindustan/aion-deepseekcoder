# AION — DeepSeek VS Code Extension

AION is a developer-grade VS Code extension that integrates **DeepSeek Coder V2** via **OpenRouter**. It provides:

- 🧠 AI-powered code completions via chat
- 📂 Full-project scanning with file relationship awareness
- 🔧 Refactor suggestions, code completion, and issue resolution
- 🔐 Secure `.env` support for API key management

### 🔗 Features

- DeepSeek Coder V2 integration
- WebView chat interface (like Hugging Face UI)
- File system scanner (to crawl the entire project)
- OpenRouter API support (via `axios` + `dotenv`)

### 🚀 Getting Started

1. Clone the repo
2. Add your API key to `.env`:
   ```bash
   OPENROUTER_API_KEY=your_key_here
