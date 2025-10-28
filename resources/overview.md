# GraphQL MCP Server Overview

A Model Context Protocol (MCP) server that exposes your GraphQL API as tools and resources.

## What It Does

This server connects to any GraphQL API and automatically:
- Discovers all available queries and mutations from your GraphQL schema
- Exposes them as callable tools through the MCP protocol
- Allows MCP clients (like Claude) to execute GraphQL operations directly
- Provides context through markdown resources in the `resources/` directory

## Configuration

Configure which GraphQL operations to expose in `exposed.yaml`:

```yaml
exposed:
  queries:
    - api.users.list
    - api.products.get
  mutations:
    - api.users.create
    - api.products.update
```

## Usage

Start the server:
```bash
GRAPHQL_URL=https://your-api.com/graphql node src/index.js
```

Supported transports:
- **STDIO** (default) - for Claude integration
- **HTTP** - for network access on specified port

## Authentication

Pass a bearer token for GraphQL authentication:
```bash
GRAPHQL_TOKEN=your_token GRAPHQL_URL=... node src/index.js
```
