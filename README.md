# GraphQL MCP Server

A Model Context Protocol (MCP) server that dynamically generates tools for any GraphQL API by introspecting its schema.

## Features

- Automatic tool generation from GraphQL schema introspection
- Support for all GraphQL queries and mutations
- Type-safe variable handling
- Automatic query generation with smart field selection
- Error handling and validation
- **Function exposure control via exposed.yaml**
- **Bearer token authentication support**

## Function Exposure Control

The server automatically manages which GraphQL functions are exposed as MCP tools through an `exposed.yaml` file:

### How it works

1. **First run**: Server discovers all GraphQL queries and mutations, creates `exposed.yaml` with all functions set to `true`
2. **Subsequent runs**: Only functions marked as `true` in `exposed.yaml` are registered as MCP tools
3. **Dynamic updates**: New functions are automatically added to the file with default `true` value
4. **Cleanup**: Functions that no longer exist in the schema are removed from the file

### exposed.yaml format

```yaml
exposed:
  queries:
    getUser: true
    listPosts: false
    searchContent: true
  mutations:
    createUser: true
    deleteUser: false
    updatePost: true
```

### Managing exposed functions

- Set a function to `false` to disable it (won't be registered as MCP tool)
- Set a function to `true` to enable it (will be registered as MCP tool)
- The file is automatically updated when the schema changes

## Installation

```bash
npm install
```

## Configuration

### GraphQL Endpoint

Set the GraphQL endpoint URL via environment variable or command line argument:

```bash
# Via environment variable
export GRAPHQL_URL="https://api.example.com/graphql"

# Via command line argument
node src/index.js --graphql-url "https://api.example.com/graphql"
```

### GraphQL API Authentication

For GraphQL APIs requiring Bearer token authentication:

```bash
# Via environment variable
export GRAPHQL_TOKEN="your-bearer-token"

# Via command line argument
node src/index.js --token "your-bearer-token"

# Both URL and token as arguments
node src/index.js --graphql-url "https://api.example.com/graphql" --token "your-bearer-token"
```

## Usage

### Running the server

#### STDIO Transport (default)
```bash
npm start
# or
node src/index.js
```

#### HTTP Transport
```bash
npm run start:http
# or
node src/index.js --transport http

# Custom port
node src/index.js --transport http --port 8080
```

### Development mode

```bash
# STDIO transport
npm run dev

# HTTP transport
npm run dev:http
```

### Command Line Options

```bash
node src/index.js [options]

Options:
  -t, --transport <type>     Transport type: stdio or http (default: stdio)
  -p, --port <number>        HTTP port (default: 3000)
  -u, --graphql-url <url>    GraphQL endpoint URL
  -T, --token <token>        Bearer token for authentication
  -q, --query-prefix <str>   Prefix for query tools (default: none)
  -m, --mutation-prefix <str> Prefix for mutation tools (default: none)
  -h, --help                 Show help message
```

### Integration with Claude Desktop

#### STDIO Transport
Add to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "graphql": {
      "command": "node",
      "args": ["/path/to/graphql-mcp-server/src/index.js"],
      "env": {
        "GRAPHQL_URL": "https://api.example.com/graphql",
        "GRAPHQL_TOKEN": "your-bearer-token"
      }
    }
  }
}
```

**Alternative using command line arguments:**

```json
{
  "mcpServers": {
    "graphql": {
      "command": "node",
      "args": [
        "/path/to/graphql-mcp-server/src/index.js",
        "--graphql-url", "https://api.example.com/graphql",
        "--token", "your-bearer-token"
      ]
    }
  }
}
```

#### HTTP Transport
For HTTP transport, start the server separately:

```bash
# Start the server with environment variables
GRAPHQL_URL="https://api.example.com/graphql" GRAPHQL_TOKEN="your-bearer-token" node src/index.js --transport http --port 3000

# Or using command line arguments
node src/index.js --transport http --port 3000 --graphql-url "https://api.example.com/graphql" --token "your-bearer-token"
```

Then configure your MCP client to connect to the HTTP endpoint at `http://localhost:3000/mcp`.

### MCP Server Authentication (HTTP Transport)

When using HTTP transport, you can secure the MCP server with bearer token authentication:

```bash
# Set AUTH_TOKEN environment variable
export AUTH_TOKEN="your-mcp-secret-token"
node src/index.js --transport http

# Or in docker-compose.yml
environment:
  - AUTH_TOKEN=your-mcp-secret-token
```

When `AUTH_TOKEN` is set:
- All HTTP requests to the MCP server must include: `Authorization: Bearer your-mcp-secret-token`
- Requests without valid tokens receive 401 Unauthorized
- If `AUTH_TOKEN` is not set, the server allows open access (no authentication required)

### HTTP API Endpoints

When running with HTTP transport:

- **POST /mcp** - Main MCP protocol endpoint
- **GET /mcp** - Returns method not allowed (405)

#### Example HTTP Usage

```bash
# Without authentication (when AUTH_TOKEN is not set)
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'

# With authentication (when AUTH_TOKEN is set)
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-mcp-secret-token" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'

# Call a GraphQL query tool
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "query_getUser",
      "arguments": {
        "variables": {
          "id": "123"
        }
      }
    }
  }'
```

## How it works

1. On startup, the server connects to the specified GraphQL endpoint (with optional Bearer token authentication)
2. It loads the `exposed.yaml` configuration file (creates it if it doesn't exist)
3. It performs an introspection query to fetch the complete schema
4. For each query and mutation in the schema, it checks if the function is enabled in `exposed.yaml`
5. Only enabled functions are registered as MCP tools with prefixes: `query_` for queries and `mutation_` for mutations
6. New functions discovered in the schema are automatically added to `exposed.yaml` as enabled
7. When a tool is called, it constructs the appropriate GraphQL query/mutation and executes it
8. Results are returned as formatted JSON

## Tool naming convention

- Queries: `query_<fieldName>` (e.g., `query_getUser`, `query_listPosts`)
- Mutations: `mutation_<fieldName>` (e.g., `mutation_createUser`, `mutation_updatePost`)

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GRAPHQL_URL` | GraphQL endpoint URL | Yes (if not provided via `--graphql-url`) |
| `GRAPHQL_TOKEN` | Bearer token for GraphQL API authentication | No |
| `AUTH_TOKEN` | Bearer token for MCP server authentication (HTTP transport only) | No |

## Files

| File | Description |
|------|-------------|
| `exposed.yaml` | Configuration file controlling which GraphQL functions are exposed as MCP tools |

## Transport Protocols

The server supports two transport protocols:

### STDIO Transport
- Default transport for MCP
- Uses standard input/output for communication
- Suitable for direct integration with MCP clients
- Lower overhead, faster communication

### HTTP Transport
- StreamableHTTP transport using MCP SDK
- JSON-RPC over HTTP
- Express.js server for HTTP handling
- Suitable for web applications and remote access
- Standard MCP protocol compliance

## Example

For a GraphQL schema with:
```graphql
type Query {
  getUser(id: ID!): User
  listPosts(limit: Int): [Post]
}

type Mutation {
  createUser(input: CreateUserInput!): User
}
```

The MCP server will generate tools:
- `query_getUser` - with required `id` parameter
- `query_listPosts` - with optional `limit` parameter
- `mutation_createUser` - with required `input` parameter

## License

MIT