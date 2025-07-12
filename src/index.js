#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import express from 'express';
import { GraphQLClient } from 'graphql-request';
import {
  getIntrospectionQuery,
  buildClientSchema,
  isNonNullType,
  isListType,
  isScalarType,
  isObjectType,
  isEnumType,
} from 'graphql';

const GRAPHQL_URL = process.env.GRAPHQL_URL;

if (!GRAPHQL_URL) {
  console.error('Error: GRAPHQL_URL environment variable is required');
  process.exit(1);
}

class GraphQLMCPServer {
  constructor() {
    this.client = new GraphQLClient(GRAPHQL_URL);
    this.schema = null;
    this.server = new McpServer(
      {
        name: 'graphql-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
  }

  async fetchSchema() {
    try {
      console.log('Fetching GraphQL schema from:', GRAPHQL_URL);
      const introspectionQuery = getIntrospectionQuery();
      const result = await this.client.request(introspectionQuery);
      
      if (!result || !result.__schema) {
        throw new Error('Invalid introspection result - missing __schema');
      }
      
      this.schema = buildClientSchema(result);
      console.log('GraphQL schema fetched successfully');
    } catch (error) {
      console.error('Failed to fetch GraphQL schema:', error);
      throw error;
    }
  }

  getTypeDescription(type) {
    let baseType = type;
    let modifiers = '';

    if (isNonNullType(type)) {
      baseType = type.ofType;
      modifiers = '!';
    }

    if (isListType(baseType)) {
      baseType = baseType.ofType;
      modifiers = `[${this.getTypeDescription(baseType)}]${modifiers}`;
      return modifiers;
    }

    if (isScalarType(baseType) || isEnumType(baseType) || isObjectType(baseType)) {
      return `${baseType.name}${modifiers}`;
    }

    return `${baseType}${modifiers}`;
  }

  getFieldDescription(field) {
    const args = field.args || [];
    const argsDesc = args.length > 0
      ? `(${args.map((arg) => `${arg.name}: ${this.getTypeDescription(arg.type)}`).join(', ')})`
      : '';
    
    return `${field.name}${argsDesc}: ${this.getTypeDescription(field.type)}`;
  }

  getBaseType(type) {
    if (!type) {
      console.warn('getBaseType called with null/undefined type');
      return null;
    }
    
    let baseType = type;
    
    // Unwrap NonNull and List wrappers to get to the base type
    while (baseType && (isNonNullType(baseType) || isListType(baseType))) {
      baseType = baseType.ofType;
    }
    
    return baseType;
  }

  isListTypeCheck(type) {
    if (!type) {
      return false;
    }
    
    let currentType = type;
    
    // Check if type is wrapped in NonNull
    if (isNonNullType(currentType)) {
      currentType = currentType.ofType;
    }
    
    return isListType(currentType);
  }

  getJsonSchemaType(graphqlType) {
    let type = graphqlType;
    
    if (isNonNullType(type)) {
      type = type.ofType;
    }

    if (isListType(type)) {
      return 'array';
    }

    if (isScalarType(type)) {
      switch (type.name) {
        case 'Int':
        case 'Float':
          return 'number';
        case 'String':
        case 'ID':
          return 'string';
        case 'Boolean':
          return 'boolean';
        default:
          return 'string';
      }
    }

    return 'object';
  }

  buildGraphQLQuery(operation, fieldName, field, variables) {
    const variableDefinitions = field.args
      .map((arg) => `$${arg.name}: ${this.getTypeDescription(arg.type)}`)
      .join(', ');

    const variableUsage = field.args
      .map((arg) => `${arg.name}: $${arg.name}`)
      .join(', ');

    const selectionSet = this.generateSelectionSet(field.type);
    
    let query;
    if (selectionSet) {
      // Field returns an object type, needs selection set
      query = `
        ${operation} ${fieldName}${variableDefinitions ? `(${variableDefinitions})` : ''} {
          ${fieldName}${variableUsage ? `(${variableUsage})` : ''} {
            ${selectionSet}
          }
        }
      `;
    } else {
      // Field returns scalar/enum/list of scalars, no selection set needed
      query = `
        ${operation} ${fieldName}${variableDefinitions ? `(${variableDefinitions})` : ''} {
          ${fieldName}${variableUsage ? `(${variableUsage})` : ''}
        }
      `;
    }

    return query;
  }

  generateSelectionSet(type, depth = 0) {
    // First, unwrap the type to get to the base type
    let baseType = type;
    
    // Unwrap NonNull wrapper
    if (isNonNullType(baseType)) {
      baseType = baseType.ofType;
    }

    // Unwrap List wrapper
    if (isListType(baseType)) {
      baseType = baseType.ofType;
      // Unwrap NonNull inside list if present
      if (isNonNullType(baseType)) {
        baseType = baseType.ofType;
      }
    }

    // If the base type is scalar or enum, no selection set needed
    if (isScalarType(baseType) || isEnumType(baseType)) {
      return null;
    }

    // Only object types need selection sets
    if (isObjectType(baseType)) {
      if (depth > 3) {
        return '__typename';
      }
      
      const fields = baseType.getFields();
      const selections = [];

      for (const [fieldName, field] of Object.entries(fields)) {
        if (field.args.length === 0) {
          // Get the field's base type
          let fieldBaseType = field.type;
          if (isNonNullType(fieldBaseType)) {
            fieldBaseType = fieldBaseType.ofType;
          }
          if (isListType(fieldBaseType)) {
            fieldBaseType = fieldBaseType.ofType;
            if (isNonNullType(fieldBaseType)) {
              fieldBaseType = fieldBaseType.ofType;
            }
          }
          
          if (isScalarType(fieldBaseType) || isEnumType(fieldBaseType)) {
            selections.push(fieldName);
          } else if (isObjectType(fieldBaseType)) {
            const subSelection = this.generateSelectionSet(field.type, depth + 1);
            if (subSelection) {
              selections.push(`${fieldName} { ${subSelection} }`);
            }
          }
        }
      }

      return selections.length > 0 ? selections.join('\n          ') : '__typename';
    }

    // Fallback
    return '__typename';
  }

  generateInputSchema(args) {
    if (!args || args.length === 0) {
      return z.object({}).optional().default({});
    }

    const properties = {};
    
    for (const arg of args) {
      const key = arg.name;
      let zodType;
      
      // Map GraphQL types to Zod types
      const graphqlType = this.getBaseType(arg.type);
      const isRequired = isNonNullType(arg.type);
      const isList = this.isListTypeCheck(arg.type);
      
      if (isScalarType(graphqlType)) {
        switch (graphqlType.name) {
          case 'String':
          case 'ID':
            zodType = z.string();
            break;
          case 'Int':
            zodType = z.number().int();
            break;
          case 'Float':
            zodType = z.number();
            break;
          case 'Boolean':
            zodType = z.boolean();
            break;
          default:
            zodType = z.any();
        }
      } else if (isEnumType(graphqlType)) {
        // For enums, create a union of string literals
        const enumValues = graphqlType.getValues();
        if (enumValues && enumValues.length > 0) {
          const enumNames = enumValues.map(v => v.name);
          // Ensure we have at least one value for z.enum and convert to tuple
          if (enumNames.length === 1) {
            zodType = z.literal(enumNames[0]);
          } else if (enumNames.length > 1) {
            zodType = z.enum([enumNames[0], ...enumNames.slice(1)]);
          } else {
            zodType = z.string();
          }
        } else {
          zodType = z.string();
        }
      } else {
        // For complex types (objects, etc.), use any
        zodType = z.any();
      }
      
        // Ensure zodType is valid before using it
        if (!zodType) {
          console.warn(`Failed to generate zodType for ${key}, using z.any()`);
          zodType = z.any();
        }
        
        // Handle arrays
        if (isList) {
          zodType = z.array(zodType);
        }
        
        // Handle optional vs required
        if (!isRequired) {
          zodType = zodType.optional();
        }
        
        // Add description
        try {
          const typeDesc = this.getTypeDescription(arg.type);
          zodType = zodType.describe(arg.description || `${typeDesc} - ${arg.name}`);
        } catch (error) {
          console.warn(`Failed to add description for ${key}:`, error);
        }
        
        properties[key] = zodType;
        console.log(`Successfully processed arg ${key}`);
      }

      console.log('generateInputSchema completed, properties:', Object.keys(properties));
      // Return the properties object directly, not wrapped in z.object()
      // The MCP SDK expects a plain object with Zod schemas as values
      return properties;
  }

  async setupTools() {
    try {
      if (!this.schema) {
        await this.fetchSchema();
      }

      if (!this.schema) {
        throw new Error('Schema is null after fetch attempt');
      }

      const queryType = this.schema.getQueryType();
      const mutationType = this.schema.getMutationType();
      
      console.log('Schema types found:', {
        hasQueryType: !!queryType,
        hasMutationType: !!mutationType,
        queryFields: queryType ? Object.keys(queryType.getFields()).length : 0,
        mutationFields: mutationType ? Object.keys(mutationType.getFields()).length : 0
      });

    if (queryType) {
      console.log('Processing query type...');
      const fields = queryType.getFields();
      console.log('Query fields:', Object.keys(fields));
      
      for (const [fieldName, field] of Object.entries(fields)) {
        console.log(`Processing query field: ${fieldName}`);
        const toolName = `query_${fieldName}`;
        
        try {
          console.log(`Generating input schema for query ${fieldName}...`);
          const inputSchema = this.generateInputSchema(field.args);
          console.log(`Input schema generated for query ${fieldName}`);
          
          // Validate the input schema before registering
          if (!inputSchema || typeof inputSchema !== 'object') {
            console.error(`Invalid input schema for ${toolName}:`, inputSchema);
            throw new Error(`Invalid input schema generated for ${toolName}`);
          }
          
          console.log(`Registering tool ${toolName} with schema keys:`, Object.keys(inputSchema));
          
          this.server.registerTool(
            toolName,
            {
              title: `GraphQL Query: ${fieldName}`,
              description: field.description || `Execute GraphQL query: ${this.getFieldDescription(field)}`,
              inputSchema: inputSchema,
            },
            async (args) => {
              try {
                console.log(`Executing query ${fieldName} with args:`, args);
                const query = this.buildGraphQLQuery('query', fieldName, field, args);
                console.log('Generated query:', query);
                const result = await this.client.request(query, args);
                
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(result, null, 2),
                    },
                  ],
                };
              } catch (error) {
                console.error(`GraphQL query ${fieldName} failed:`, error);
                throw new Error(`GraphQL query failed: ${error.message}`);
              }
            }
          );
          console.log(`Registered query tool: ${toolName}`);
        } catch (error) {
          console.error(`Failed to register query tool ${toolName}:`, error);
        }
      }
    }

    if (mutationType) {
      console.log('Processing mutation type...');
      const fields = mutationType.getFields();
      console.log('Mutation fields:', Object.keys(fields));
      
      for (const [fieldName, field] of Object.entries(fields)) {
        console.log(`Processing mutation field: ${fieldName}`);
        const toolName = `mutation_${fieldName}`;
        
        try {
          console.log(`Generating input schema for mutation ${fieldName}...`);
          const inputSchema = this.generateInputSchema(field.args);
          console.log(`Input schema generated for mutation ${fieldName}`);
          
          // Validate the input schema before registering
          if (!inputSchema || typeof inputSchema !== 'object') {
            console.error(`Invalid input schema for ${toolName}:`, inputSchema);
            throw new Error(`Invalid input schema generated for ${toolName}`);
          }
          
          console.log(`Registering tool ${toolName} with schema keys:`, Object.keys(inputSchema));
          
          this.server.registerTool(
            toolName,
            {
              title: `GraphQL Mutation: ${fieldName}`,
              description: field.description || `Execute GraphQL mutation: ${this.getFieldDescription(field)}`,
              inputSchema: inputSchema,
            },
            async (args) => {
              try {
                console.log(`Executing mutation ${fieldName} with args:`, args);
                const query = this.buildGraphQLQuery('mutation', fieldName, field, args);
                console.log('Generated mutation:', query);
                const result = await this.client.request(query, args);
                
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(result, null, 2),
                    },
                  ],
                };
              } catch (error) {
                console.error(`GraphQL mutation ${fieldName} failed:`, error);
                throw new Error(`GraphQL mutation failed: ${error.message}`);
              }
            }
          );
          console.log(`Registered mutation tool: ${toolName}`);
        } catch (error) {
          console.error(`Failed to register mutation tool ${toolName}:`, error);
        }
      }
    }
    } catch (error) {
      console.error('Error in setupTools:', error);
      throw error;
    }
  }

  async run(transport = 'stdio', port = 3000) {
    // Setup tools first
    await this.setupTools();
    
    if (transport === 'http') {
      await this.runHttpServer(port);
    } else {
      await this.runStdioServer();
    }
  }

  async runStdioServer() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('GraphQL MCP server running on stdio');
  }

  async runHttpServer(port) {
    const app = express();
    app.use(express.json());

    app.post('/mcp', async (req, res) => {
      console.log('Received POST MCP request');
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on('close', () => {
          transport.close();
        });
        await this.server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: null,
          });
        }
      }
    });

    app.get('/mcp', async (req, res) => {
      console.log('Received GET MCP request');
      res.writeHead(405).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed."
        },
        id: null
      }));
    });

    app.delete('/mcp', async (req, res) => {
      console.log('Received DELETE MCP request');
      res.writeHead(405).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed."
        },
        id: null
      }));
    });

    app.listen(port, () => {
      console.log(`GraphQL MCP server listening on port ${port}`);
      console.log(`MCP endpoint: http://localhost:${port}/mcp`);
    });
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    transport: 'stdio',
    port: 3000
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--transport':
      case '-t':
        config.transport = args[++i];
        break;
      case '--port':
      case '-p':
        config.port = parseInt(args[++i]);
        break;
      case '--help':
      case '-h':
        console.log(`
GraphQL MCP Server

Usage: node src/index.js [options]

Options:
  -t, --transport <type>  Transport type: stdio or http (default: stdio)
  -p, --port <number>     HTTP port (default: 3000)
  -h, --help             Show this help message

Environment Variables:
  GRAPHQL_URL            GraphQL endpoint URL (required)

Examples:
  node src/index.js                           # Run with stdio transport
  node src/index.js -t http                   # Run with HTTP transport on port 3000
  node src/index.js -t http -p 8080          # Run with HTTP transport on port 8080
`);
        process.exit(0);
        break;
    }
  }

  if (!['stdio', 'http'].includes(config.transport)) {
    console.error('Error: Transport must be "stdio" or "http"');
    process.exit(1);
  }

  return config;
}

const config = parseArgs();
const graphqlServer = new GraphQLMCPServer();
graphqlServer.run(config.transport, config.port).catch(console.error);