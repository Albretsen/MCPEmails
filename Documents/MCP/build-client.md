# Build an MCP Client

> Get started building your own client that can integrate with all MCP servers.

In this tutorial, you'll learn how to build an LLM-powered chatbot client that connects to MCP servers.

Before you begin, it helps to have gone through the Build an MCP Server tutorial so you can understand how clients and servers communicate.

## Python

[Complete code: mcp-client-python](https://github.com/modelcontextprotocol/quickstart-resources/tree/main/mcp-client-python)

### System Requirements

* Mac or Windows computer
* Latest Python version installed
* Latest version of `uv` installed

### Setting Up Your Environment

```bash
uv init mcp-client
cd mcp-client
uv venv
source .venv/bin/activate
uv add mcp anthropic python-dotenv
rm main.py && touch client.py
```

### Setting Up Your API Key

```bash
echo "ANTHROPIC_API_KEY=your-api-key-goes-here" > .env
echo ".env" >> .gitignore
```

### Basic Client Structure

```python
import asyncio
from typing import Optional
from contextlib import AsyncExitStack

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

class MCPClient:
    def __init__(self):
        self.session: Optional[ClientSession] = None
        self.exit_stack = AsyncExitStack()
        self.anthropic = Anthropic()
```

### Server Connection Management

```python
async def connect_to_server(self, server_script_path: str):
    """Connect to an MCP server

    Args:
        server_script_path: Path to the server script (.py or .js)
    """
    is_python = server_script_path.endswith('.py')
    is_js = server_script_path.endswith('.js')
    if not (is_python or is_js):
        raise ValueError("Server script must be a .py or .js file")

    command = "python" if is_python else "node"
    server_params = StdioServerParameters(
        command=command,
        args=[server_script_path],
        env=None
    )

    stdio_transport = await self.exit_stack.enter_async_context(stdio_client(server_params))
    self.stdio, self.write = stdio_transport
    self.session = await self.exit_stack.enter_async_context(ClientSession(self.stdio, self.write))

    await self.session.initialize()

    response = await self.session.list_tools()
    tools = response.tools
    print("\nConnected to server with tools:", [tool.name for tool in tools])
```

### Query Processing Logic

```python
async def process_query(self, query: str) -> str:
    """Process a query using Claude and available tools"""
    messages = [{"role": "user", "content": query}]

    response = await self.session.list_tools()
    available_tools = [{
        "name": tool.name,
        "description": tool.description,
        "input_schema": tool.inputSchema
    } for tool in response.tools]

    response = self.anthropic.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1000,
        messages=messages,
        tools=available_tools
    )

    final_text = []
    assistant_message_content = []

    for content in response.content:
        if content.type == 'text':
            final_text.append(content.text)
            assistant_message_content.append(content)
        elif content.type == 'tool_use':
            tool_name = content.name
            tool_args = content.input

            result = await self.session.call_tool(tool_name, tool_args)
            final_text.append(f"[Calling tool {tool_name} with args {tool_args}]")

            assistant_message_content.append(content)
            messages.append({"role": "assistant", "content": assistant_message_content})
            messages.append({
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": content.id, "content": result.content}]
            })

            response = self.anthropic.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=1000,
                messages=messages,
                tools=available_tools
            )
            final_text.append(response.content[0].text)

    return "\n".join(final_text)
```

### Interactive Chat Interface

```python
async def chat_loop(self):
    """Run an interactive chat loop"""
    print("\nMCP Client Started!")
    print("Type your queries or 'quit' to exit.")

    while True:
        try:
            query = input("\nQuery: ").strip()
            if query.lower() == 'quit':
                break
            response = await self.process_query(query)
            print("\n" + response)
        except Exception as e:
            print(f"\nError: {str(e)}")

async def cleanup(self):
    """Clean up resources"""
    await self.exit_stack.aclose()
```

### Main Entry Point

```python
async def main():
    if len(sys.argv) < 2:
        print("Usage: python client.py <path_to_server_script>")
        sys.exit(1)

    client = MCPClient()
    try:
        await client.connect_to_server(sys.argv[1])
        await client.chat_loop()
    finally:
        await client.cleanup()

if __name__ == "__main__":
    import sys
    asyncio.run(main())
```

### Running the Client

```bash
uv run client.py path/to/server.py   # python server
uv run client.py path/to/build/index.js  # node server
```

---

## TypeScript

[Complete code: mcp-client-typescript](https://github.com/modelcontextprotocol/quickstart-resources/tree/main/mcp-client-typescript)

### System Requirements

* Mac or Windows computer
* Node.js 17 or higher
* Anthropic API key

### Setting Up Your Environment

```bash
mkdir mcp-client-typescript && cd mcp-client-typescript
npm init -y
npm install @anthropic-ai/sdk @modelcontextprotocol/sdk dotenv
npm install -D @types/node typescript
touch index.ts
```

**package.json**:
```json
{
  "type": "module",
  "scripts": { "build": "tsc && chmod 755 build/index.js" }
}
```

**tsconfig.json**:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

### Basic Client Structure

```typescript
import { Anthropic } from "@anthropic-ai/sdk";
import { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";
import dotenv from "dotenv";

dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

class MCPClient {
  private mcp: Client;
  private anthropic: Anthropic;
  private transport: StdioClientTransport | null = null;
  private tools: Tool[] = [];

  constructor() {
    this.anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
  }
}
```

### Server Connection Management

```typescript
async connectToServer(serverScriptPath: string) {
  const isJs = serverScriptPath.endsWith(".js");
  const isPy = serverScriptPath.endsWith(".py");
  if (!isJs && !isPy) throw new Error("Server script must be a .js or .py file");

  const command = isPy
    ? process.platform === "win32" ? "python" : "python3"
    : process.execPath;

  this.transport = new StdioClientTransport({ command, args: [serverScriptPath] });
  await this.mcp.connect(this.transport);

  const toolsResult = await this.mcp.listTools();
  this.tools = toolsResult.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
  console.log("Connected to server with tools:", this.tools.map(({ name }) => name));
}
```

### Query Processing Logic

```typescript
async processQuery(query: string) {
  const messages: MessageParam[] = [{ role: "user", content: query }];

  const response = await this.anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages,
    tools: this.tools,
  });

  const finalText = [];

  for (const content of response.content) {
    if (content.type === "text") {
      finalText.push(content.text);
    } else if (content.type === "tool_use") {
      const toolName = content.name;
      const toolArgs = content.input as { [x: string]: unknown } | undefined;

      const result = await this.mcp.callTool({ name: toolName, arguments: toolArgs });
      finalText.push(`[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`);

      messages.push({ role: "user", content: result.content as string });

      const followUp = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages,
      });
      finalText.push(followUp.content[0].type === "text" ? followUp.content[0].text : "");
    }
  }

  return finalText.join("\n");
}
```

### Chat Loop and Cleanup

```typescript
async chatLoop() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\nMCP Client Started!");
    while (true) {
      const message = await rl.question("\nQuery: ");
      if (message.toLowerCase() === "quit") break;
      const response = await this.processQuery(message);
      console.log("\n" + response);
    }
  } finally {
    rl.close();
  }
}

async cleanup() {
  await this.mcp.close();
}
```

### Running the Client

```bash
npm run build
node build/index.js path/to/server.py     # python server
node build/index.js path/to/build/index.js  # node server
```

---

## Java (Spring AI)

[Complete code: brave-chatbot](https://github.com/spring-projects/spring-ai-examples/tree/main/model-context-protocol/web-search/brave-chatbot)

```xml
<dependency>
  <groupId>org.springframework.ai</groupId>
  <artifactId>spring-ai-starter-mcp-client</artifactId>
</dependency>
<dependency>
  <groupId>org.springframework.ai</groupId>
  <artifactId>spring-ai-starter-model-anthropic</artifactId>
</dependency>
```

**application.yml**:
```yaml
spring:
  ai:
    mcp:
      client:
        enabled: true
        stdio:
          servers-configuration: classpath:/mcp-servers-config.json
        toolcallback:
          enabled: true
    anthropic:
      api-key: ${ANTHROPIC_API_KEY}
```

**mcp-servers-config.json**:
```json
{
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": { "BRAVE_API_KEY": "<YOUR KEY>" }
    }
  }
}
```

**Chat Implementation**:
```java
var chatClient = chatClientBuilder
    .defaultSystem("You are useful assistant, expert in AI and Java.")
    .defaultToolCallbacks((Object[]) mcpToolAdapter.toolCallbacks())
    .defaultAdvisors(new MessageChatMemoryAdvisor(new InMemoryChatMemory()))
    .build();
```

---

## How It Works (All Languages)

When you submit a query:

1. The client gets the list of available tools from the server
2. Your query is sent to Claude along with tool descriptions
3. Claude decides which tools (if any) to use
4. The client executes any requested tool calls through the server
5. Results are sent back to Claude
6. Claude provides a natural language response
7. The response is displayed to you

## Best Practices

1. **Error Handling**: Always wrap tool calls in try-catch blocks
2. **Resource Management**: Use proper cleanup (AsyncExitStack in Python, `mcp.close()` in TypeScript)
3. **Security**: Store API keys securely in `.env`
4. **Response Timing**: The first response might take up to 30 seconds while the server initializes

## Troubleshooting

* `FileNotFoundError` / `ENOENT`: Check your server path
* `Connection refused`: Ensure the server is running and the path is correct
* `Tool execution failed`: Verify the tool's required environment variables are set
* `ANTHROPIC_API_KEY is not set`: Check your .env file

---

*Source: https://modelcontextprotocol.io/docs/develop/build-client*
