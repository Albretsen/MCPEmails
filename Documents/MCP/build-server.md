# Build an MCP Server

> Get started building your own server to use in Claude for Desktop and other clients.

In this tutorial, we'll build a simple MCP weather server and connect it to a host, Claude for Desktop.

## What we'll be building

We'll build a server that exposes two tools: `get_alerts` and `get_forecast`.

## Core MCP Concepts

MCP servers can provide three main types of capabilities:

1. **Resources**: File-like data that can be read by clients (like API responses or file contents)
2. **Tools**: Functions that can be called by the LLM (with user approval)
3. **Prompts**: Pre-written templates that help users accomplish specific tasks

## Python

[Complete code: weather-server-python](https://github.com/modelcontextprotocol/quickstart-resources/tree/main/weather-server-python)

### Logging in MCP Servers

**For STDIO-based servers:** Never write to stdout. Writing to stdout will corrupt the JSON-RPC messages and break your server.

```python
import sys
import logging

# Bad (STDIO)
print("Processing request")

# Good (STDIO)
print("Processing request", file=sys.stderr)
logging.info("Processing request")
```

### System requirements

* Python 3.10 or higher
* MCP SDK 1.2.0 or higher

### Set up your environment

```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Create and set up project
uv init weather
cd weather
uv venv
source .venv/bin/activate
uv add "mcp[cli]" httpx

touch weather.py
```

### Importing packages and setting up the instance

```python
from typing import Any
import httpx
from mcp.server.fastmcp import FastMCP

# Initialize FastMCP server
mcp = FastMCP("weather")

# Constants
NWS_API_BASE = "https://api.weather.gov"
USER_AGENT = "weather-app/1.0"
```

### Helper functions

```python
async def make_nws_request(url: str) -> dict[str, Any] | None:
    """Make a request to the NWS API with proper error handling."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/geo+json"}
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, headers=headers, timeout=30.0)
            response.raise_for_status()
            return response.json()
        except Exception:
            return None


def format_alert(feature: dict) -> str:
    """Format an alert feature into a readable string."""
    props = feature["properties"]
    return f"""
Event: {props.get("event", "Unknown")}
Area: {props.get("areaDesc", "Unknown")}
Severity: {props.get("severity", "Unknown")}
Description: {props.get("description", "No description available")}
Instructions: {props.get("instruction", "No specific instructions provided")}
"""
```

### Implementing tool execution

```python
@mcp.tool()
async def get_alerts(state: str) -> str:
    """Get weather alerts for a US state.

    Args:
        state: Two-letter US state code (e.g. CA, NY)
    """
    url = f"{NWS_API_BASE}/alerts/active/area/{state}"
    data = await make_nws_request(url)

    if not data or "features" not in data:
        return "Unable to fetch alerts or no alerts found."

    if not data["features"]:
        return "No active alerts for this state."

    alerts = [format_alert(feature) for feature in data["features"]]
    return "\n---\n".join(alerts)


@mcp.tool()
async def get_forecast(latitude: float, longitude: float) -> str:
    """Get weather forecast for a location.

    Args:
        latitude: Latitude of the location
        longitude: Longitude of the location
    """
    points_url = f"{NWS_API_BASE}/points/{latitude},{longitude}"
    points_data = await make_nws_request(points_url)

    if not points_data:
        return "Unable to fetch forecast data for this location."

    forecast_url = points_data["properties"]["forecast"]
    forecast_data = await make_nws_request(forecast_url)

    if not forecast_data:
        return "Unable to fetch detailed forecast."

    periods = forecast_data["properties"]["periods"]
    forecasts = []
    for period in periods[:5]:
        forecast = f"""
{period["name"]}:
Temperature: {period["temperature"]}°{period["temperatureUnit"]}
Wind: {period["windSpeed"]} {period["windDirection"]}
Forecast: {period["detailedForecast"]}
"""
        forecasts.append(forecast)

    return "\n---\n".join(forecasts)
```

### Running the server

```python
def main():
    mcp.run(transport="stdio")

if __name__ == "__main__":
    main()
```

Run with: `uv run weather.py`

### Testing with Claude for Desktop

Open `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "weather": {
      "command": "uv",
      "args": [
        "--directory",
        "/ABSOLUTE/PATH/TO/PARENT/FOLDER/weather",
        "run",
        "weather.py"
      ]
    }
  }
}
```

---

## TypeScript

[Complete code: weather-server-typescript](https://github.com/modelcontextprotocol/quickstart-resources/tree/main/weather-server-typescript)

### Logging in MCP Servers

```javascript
// Bad (STDIO)
console.log("Server started");

// Good (STDIO)
console.error("Server started"); // stderr is safe
```

### Set up your environment

```bash
mkdir weather && cd weather
npm init -y
npm install @modelcontextprotocol/sdk zod@3
npm install -D @types/node typescript
mkdir src && touch src/index.ts
```

**package.json**:
```json
{
  "type": "module",
  "bin": { "weather": "./build/index.js" },
  "scripts": { "build": "tsc && chmod 755 build/index.js" },
  "files": ["build"]
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
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

### Importing packages and setting up the instance

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const NWS_API_BASE = "https://api.weather.gov";
const USER_AGENT = "weather-app/1.0";

const server = new McpServer({
  name: "weather",
  version: "1.0.0",
});
```

### Helper functions

```typescript
async function makeNWSRequest<T>(url: string): Promise<T | null> {
  const headers = { "User-Agent": USER_AGENT, Accept: "application/geo+json" };
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    console.error("Error making NWS request:", error);
    return null;
  }
}
```

### Implementing tool execution

```typescript
server.registerTool(
  "get_alerts",
  {
    description: "Get weather alerts for a state",
    inputSchema: {
      state: z.string().length(2).describe("Two-letter state code (e.g. CA, NY)"),
    },
  },
  async ({ state }) => {
    const stateCode = state.toUpperCase();
    const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
    const alertsData = await makeNWSRequest<AlertsResponse>(alertsUrl);

    if (!alertsData) {
      return { content: [{ type: "text", text: "Failed to retrieve alerts data" }] };
    }

    const features = alertsData.features || [];
    if (!features.length) {
      return { content: [{ type: "text", text: `No active alerts for ${stateCode}` }] };
    }

    const alertsText = `Active alerts for ${stateCode}:\n\n${features.map(formatAlert).join("\n")}`;
    return { content: [{ type: "text", text: alertsText }] };
  },
);

server.registerTool(
  "get_forecast",
  {
    description: "Get weather forecast for a location",
    inputSchema: {
      latitude: z.number().min(-90).max(90).describe("Latitude"),
      longitude: z.number().min(-180).max(180).describe("Longitude"),
    },
  },
  async ({ latitude, longitude }) => {
    const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const pointsData = await makeNWSRequest<PointsResponse>(pointsUrl);

    if (!pointsData) {
      return { content: [{ type: "text", text: "Failed to retrieve grid point data" }] };
    }

    const forecastUrl = pointsData.properties?.forecast;
    if (!forecastUrl) {
      return { content: [{ type: "text", text: "Failed to get forecast URL" }] };
    }

    const forecastData = await makeNWSRequest<ForecastResponse>(forecastUrl);
    if (!forecastData) {
      return { content: [{ type: "text", text: "Failed to retrieve forecast data" }] };
    }

    const periods = forecastData.properties?.periods || [];
    const formattedForecast = periods.map((period) =>
      [`${period.name}:`, `Temperature: ${period.temperature}°${period.temperatureUnit}`,
       `Wind: ${period.windSpeed} ${period.windDirection}`, period.shortForecast, "---"].join("\n")
    );

    return { content: [{ type: "text", text: `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join("\n")}` }] };
  },
);
```

### Running the server

```typescript
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Weather MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
```

Build: `npm run build`

### Testing with Claude for Desktop

```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/PARENT/FOLDER/weather/build/index.js"]
    }
  }
}
```

---

## Java (Spring AI)

[Complete code: weather-server-java](https://github.com/spring-projects/spring-ai-examples/tree/main/model-context-protocol/weather/starter-stdio-server)

### System requirements

* Java 17 or higher
* Spring Boot 3.3.x or higher

### Dependencies

```xml
<dependencies>
  <dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-mcp-server</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework</groupId>
    <artifactId>spring-web</artifactId>
  </dependency>
</dependencies>
```

### Weather Service

```java
@Service
public class WeatherService {
  private final RestClient restClient;

  public WeatherService() {
    this.restClient = RestClient.builder()
      .baseUrl("https://api.weather.gov")
      .defaultHeader("Accept", "application/geo+json")
      .defaultHeader("User-Agent", "WeatherApiClient/1.0 (your@email.com)")
      .build();
  }

  @Tool(description = "Get weather forecast for a specific latitude/longitude")
  public String getWeatherForecastByLocation(double latitude, double longitude) {
    // Implementation
  }

  @Tool(description = "Get weather alerts for a US state")
  public String getAlerts(
    @ToolParam(description = "Two-letter US state code (e.g. CA, NY)") String state
  ) {
    // Implementation
  }
}
```

### Main Application

```java
@SpringBootApplication
public class McpServerApplication {
  public static void main(String[] args) {
    SpringApplication.run(McpServerApplication.class, args);
  }

  @Bean
  public ToolCallbackProvider weatherTools(WeatherService weatherService) {
    return MethodToolCallbackProvider.builder().toolObjects(weatherService).build();
  }
}
```

Build: `./mvnw clean install`

### Claude for Desktop config

```json
{
  "mcpServers": {
    "spring-ai-mcp-weather": {
      "command": "java",
      "args": [
        "-Dspring.ai.mcp.server.stdio=true",
        "-jar",
        "/ABSOLUTE/PATH/TO/mcp-weather-stdio-server-0.0.1-SNAPSHOT.jar"
      ]
    }
  }
}
```

---

*Source: https://modelcontextprotocol.io/docs/develop/build-server*
