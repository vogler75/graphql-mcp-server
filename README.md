# GraphQL MCP Server

A Model Context Protocol (MCP) server that dynamically generates tools for any GraphQL API by introspecting its schema.

## Features

- Automatic tool generation from GraphQL schema introspection
- Support for all GraphQL queries and mutations
- Type-safe variable handling
- Automatic query generation with smart field selection
- Error handling and validation

## Installation

```bash
npm install
```

## Configuration

Set the GraphQL endpoint URL via environment variable:

```bash
export GRAPHQL_URL="https://api.example.com/graphql"
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
  -t, --transport <type>  Transport type: stdio or http (default: stdio)
  -p, --port <number>     HTTP port (default: 3000)
  -h, --help             Show help message
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
        "GRAPHQL_URL": "https://api.example.com/graphql"
      }
    }
  }
}
```

#### HTTP Transport
For HTTP transport, start the server separately:

```bash
# Start the server
GRAPHQL_URL="https://api.example.com/graphql" node src/index.js --transport http --port 3000
```

Then configure your MCP client to connect to the HTTP endpoint at `http://localhost:3000/mcp`.

### HTTP API Endpoints

When running with HTTP transport:

- **POST /mcp** - Main MCP protocol endpoint
- **GET /mcp** - Returns method not allowed (405)

#### Example HTTP Usage

```bash
# List available tools
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
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

1. On startup, the server connects to the specified GraphQL endpoint
2. It performs an introspection query to fetch the complete schema
3. For each query and mutation in the schema, it generates a corresponding MCP tool
4. Tools are named with prefixes: `query_` for queries and `mutation_` for mutations
5. When a tool is called, it constructs the appropriate GraphQL query/mutation and executes it
6. Results are returned as formatted JSON

## Tool naming convention

- Queries: `query_<fieldName>` (e.g., `query_getUser`, `query_listPosts`)
- Mutations: `mutation_<fieldName>` (e.g., `mutation_createUser`, `mutation_updatePost`)

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