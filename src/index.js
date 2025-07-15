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
import yaml from 'yaml';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GRAPHQL_TOKEN = process.env.GRAPHQL_TOKEN;

class GraphQLMCPServer {
  constructor(graphqlUrl, queryPrefix = '', mutationPrefix = '', token = null) {
    if (!graphqlUrl) {
      throw new Error('GraphQL URL is required');
    }
    
    const headers = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    
    this.client = new GraphQLClient(graphqlUrl, { headers });
    this.graphqlUrl = graphqlUrl;
    this.schema = null;
    this.queryPrefix = queryPrefix;
    this.mutationPrefix = mutationPrefix;
    this.exposedConfigPath = path.join(process.cwd(), 'exposed.yaml');
    this.exposedConfig = null;
    this.server = new McpServer(
      {
        name: 'graphql-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );
  }

  async loadExposedConfig() {
    try {
      const fileContent = await fs.readFile(this.exposedConfigPath, 'utf8');
      this.exposedConfig = yaml.parse(fileContent);
      
      // Ensure resources section exists for backward compatibility
      if (!this.exposedConfig.exposed.resources) {
        this.exposedConfig.exposed.resources = {};
      }
      
      console.log('✅ Loaded exposed.yaml configuration');
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('📝 exposed.yaml not found, will create new configuration');
        this.exposedConfig = {
          exposed: {
            queries: {},
            mutations: {},
            resources: {}
          }
        };
      } else {
        console.error('❌ Error loading exposed.yaml:', error);
        throw error;
      }
    }
  }

  async saveExposedConfig() {
    try {
      const yamlContent = yaml.stringify(this.exposedConfig);
      await fs.writeFile(this.exposedConfigPath, yamlContent, 'utf8');
      console.log('✅ Saved exposed.yaml configuration');
    } catch (error) {
      console.error('❌ Error saving exposed.yaml:', error);
      throw error;
    }
  }

  async fetchSchema() {
    try {
      console.log('🔍 Fetching GraphQL schema from:', this.graphqlUrl);
      const introspectionQuery = getIntrospectionQuery();
      const result = await this.client.request(introspectionQuery);
      
      if (!result || !result.__schema) {
        throw new Error('Invalid introspection result - missing __schema');
      }
      
      this.schema = buildClientSchema(result);
      console.log('✅ GraphQL schema fetched successfully');
    } catch (error) {
      console.error('❌ Failed to fetch GraphQL schema:', error);
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
      return {};
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
      }

      // Remove verbose logging
      // Return the properties object directly, not wrapped in z.object()
      // The MCP SDK expects a plain object with Zod schemas as values
      return properties;
  }

  async setupTools() {
    try {
      // Load exposed configuration first
      await this.loadExposedConfig();

      if (!this.schema) {
        await this.fetchSchema();
      }

      if (!this.schema) {
        throw new Error('Schema is null after fetch attempt');
      }

      const queryType = this.schema.getQueryType();
      const mutationType = this.schema.getMutationType();
      
      const queryFieldCount = queryType ? Object.keys(queryType.getFields()).length : 0;
      const mutationFieldCount = mutationType ? Object.keys(mutationType.getFields()).length : 0;
      const configuredResourceCount = Object.keys(this.exposedConfig.exposed.resources).length;
      console.log(`🛠️  Discovered ${queryFieldCount} queries, ${mutationFieldCount} mutations, and ${configuredResourceCount} configured resources`);

      // Track if we need to save the config
      let configUpdated = false;

    if (queryType) {
      const fields = queryType.getFields();
      
      for (const [fieldName, field] of Object.entries(fields)) {
        const toolName = `${this.queryPrefix}${fieldName}`;
        
        // Check if this query is in the exposed config
        if (!(fieldName in this.exposedConfig.exposed.queries)) {
          // New query discovered, add it to config with default true
          this.exposedConfig.exposed.queries[fieldName] = true;
          configUpdated = true;
          console.log(`📝 New query discovered: ${fieldName}`);
        }
        
        // Only register as tool if the query is enabled
        if (this.exposedConfig.exposed.queries[fieldName] === true) {
          try {
            const inputSchema = this.generateInputSchema(field.args);
            
            // Validate the input schema before registering
            if (!inputSchema || typeof inputSchema !== 'object') {
              console.error(`❌ Invalid input schema for ${toolName}:`, inputSchema);
              throw new Error(`Invalid input schema generated for ${toolName}`);
            }
            
            this.server.registerTool(
              toolName,
              {
                title: `GraphQL Query: ${fieldName}`,
                description: field.description || `Execute GraphQL query: ${this.getFieldDescription(field)}`,
                inputSchema: inputSchema,
              },
              async (args) => {
                try {
                  console.log
                  const query = this.buildGraphQLQuery('query', fieldName, field, args);
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
                  console.error(`❌ GraphQL query ${fieldName} failed:`, error);
                  throw new Error(`GraphQL query failed: ${error.message}`);
                }
              }
            );
            console.log(`🔧 Registered query: ${toolName}`);
          } catch (error) {
            console.error(`❌ Failed to register query tool ${toolName}:`, error);
          }
        } else {
          console.log(`⏭️  Skipped disabled query: ${fieldName}`);
        }
      }
      
      // Register resources for queries explicitly listed in resources section
      for (const [resourceName, enabled] of Object.entries(this.exposedConfig.exposed.resources)) {
        if (enabled === true && fields[resourceName]) {
          const field = fields[resourceName];
          
          try {
            this.server.registerResource(
              resourceName,
              `resource://${resourceName}`,
              {
                title: resourceName,
                description: field.description || `GraphQL query resource: ${this.getFieldDescription(field)}`,
                mimeType: 'application/json',
              },
              async (uri) => {
                try {
                  console.log(`📊 Fetching resource: ${resourceName} (${uri.href})`);
                  const query = this.buildGraphQLQuery('query', resourceName, field, {});
                  const result = await this.client.request(query, {});
                  console.log(`✅ Resource fetched successfully: ${resourceName}`);
                  
                  return {
                    contents: [
                      {
                        uri: uri.href,
                        mimeType: 'application/json',
                        text: JSON.stringify(result, null, 2),
                      },
                    ],
                  };
                } catch (error) {
                  console.error(`❌ GraphQL resource ${resourceName} failed:`, error);
                  throw new Error(`GraphQL resource failed: ${error.message}`);
                }
              }
            );
            console.log(`📊 Registered resource: ${resourceName}`);
          } catch (error) {
            console.error(`❌ Failed to register resource ${resourceName}:`, error);
          }
        } else if (enabled === true) {
          console.log(`⚠️  Resource ${resourceName} not found in GraphQL schema`);
        }
      }
      
      // Clean up removed queries
      const currentQueryNames = Object.keys(fields);
      for (const queryName in this.exposedConfig.exposed.queries) {
        if (!currentQueryNames.includes(queryName)) {
          delete this.exposedConfig.exposed.queries[queryName];
          configUpdated = true;
          console.log(`🗑️  Removed obsolete query: ${queryName}`);
        }
      }
      
      // Clean up removed resources
      for (const resourceName in this.exposedConfig.exposed.resources) {
        if (!currentQueryNames.includes(resourceName)) {
          delete this.exposedConfig.exposed.resources[resourceName];
          configUpdated = true;
          console.log(`🗑️  Removed obsolete resource: ${resourceName}`);
        }
      }
    }

    if (mutationType) {
      const fields = mutationType.getFields();
      
      for (const [fieldName, field] of Object.entries(fields)) {
        const toolName = `${this.mutationPrefix}${fieldName}`;
        
        // Check if this mutation is in the exposed config
        if (!(fieldName in this.exposedConfig.exposed.mutations)) {
          // New mutation discovered, add it to config with default true
          this.exposedConfig.exposed.mutations[fieldName] = true;
          configUpdated = true;
          console.log(`📝 New mutation discovered: ${fieldName}`);
        }
        
        // Only register if the mutation is enabled
        if (this.exposedConfig.exposed.mutations[fieldName] === true) {
          try {
            const inputSchema = this.generateInputSchema(field.args);
            
            // Validate the input schema before registering
            if (!inputSchema || typeof inputSchema !== 'object') {
              console.error(`❌ Invalid input schema for ${toolName}:`, inputSchema);
              throw new Error(`Invalid input schema generated for ${toolName}`);
            }
            
            this.server.registerTool(
              toolName,
              {
                title: `GraphQL Mutation: ${fieldName}`,
                description: field.description || `Execute GraphQL mutation: ${this.getFieldDescription(field)}`,
                inputSchema: inputSchema,
              },
              async (args) => {
                try {
                  const query = this.buildGraphQLQuery('mutation', fieldName, field, args);
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
                  console.error(`❌ GraphQL mutation ${fieldName} failed:`, error);
                  throw new Error(`GraphQL mutation failed: ${error.message}`);
                }
              }
            );
            console.log(`🔧 Registered mutation: ${toolName}`);
          } catch (error) {
            console.error(`❌ Failed to register mutation tool ${toolName}:`, error);
          }
        } else {
          console.log(`⏭️  Skipped disabled mutation: ${fieldName}`);
        }
      }
      
      // Clean up removed mutations
      const currentMutationNames = Object.keys(fields);
      for (const mutationName in this.exposedConfig.exposed.mutations) {
        if (!currentMutationNames.includes(mutationName)) {
          delete this.exposedConfig.exposed.mutations[mutationName];
          configUpdated = true;
          console.log(`🗑️  Removed obsolete mutation: ${mutationName}`);
        }
      }
    }
    
    // Save configuration if it was updated
    if (configUpdated) {
      await this.saveExposedConfig();
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
    const timestamp = new Date().toISOString();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`🚀 [${timestamp}] GraphQL MCP Server Started`);
    console.error(`   └── Transport: STDIO`);
    console.error(`   └── GraphQL URL: ${this.graphqlUrl}`);
    console.error(`   └── Authentication: ${this.client.requestConfig.headers?.Authorization ? 'Bearer Token' : 'None'}`);
    console.error(`📋 Ready to accept MCP requests via STDIO...`);
  }

  async runHttpServer(port) {
    const app = express();
    app.use(express.json());

    app.post('/mcp', async (req, res) => {
      const timestamp = new Date().toISOString();
      const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
      const userAgent = req.get('User-Agent') || 'unknown';
      const method = req.body?.method || 'unknown';
      const requestId = req.body?.id || 'N/A';
      
      console.log(`📨 [${timestamp}] MCP Request Received`);
      console.log(`   └── Method: ${method}`);
      console.log(`   └── Request ID: ${requestId}`);
      console.log(`   └── Client IP: ${clientIP}`);
      console.log(`   └── User Agent: ${userAgent.substring(0, 50)}${userAgent.length > 50 ? '...' : ''}`);
      
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on('close', () => {
          transport.close();
          console.log(`🔌 [${new Date().toISOString()}] Connection closed for request ${requestId}`);
        });
        await this.server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        console.log(`✅ [${new Date().toISOString()}] MCP Request processed successfully (${method}, ID: ${requestId})`);
      } catch (error) {
        console.error(`❌ [${new Date().toISOString()}] Error handling MCP request (${method}, ID: ${requestId}):`, error.message);
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
      const timestamp = new Date().toISOString();
      const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
      const userAgent = req.get('User-Agent') || 'unknown';
      
      console.log(`🚫 [${timestamp}] Invalid MCP Request - GET Method Not Allowed`);
      console.log(`   └── Client IP: ${clientIP}`);
      console.log(`   └── User Agent: ${userAgent.substring(0, 50)}${userAgent.length > 50 ? '...' : ''}`);
      console.log(`   └── Expected: POST request to /mcp endpoint`);
      
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
      const timestamp = new Date().toISOString();
      const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
      const userAgent = req.get('User-Agent') || 'unknown';
      
      console.log(`🚫 [${timestamp}] Invalid MCP Request - DELETE Method Not Allowed`);
      console.log(`   └── Client IP: ${clientIP}`);
      console.log(`   └── User Agent: ${userAgent.substring(0, 50)}${userAgent.length > 50 ? '...' : ''}`);
      console.log(`   └── Expected: POST request to /mcp endpoint`);
      
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
      const timestamp = new Date().toISOString();
      console.log(`🚀 [${timestamp}] GraphQL MCP Server Started`);
      console.log(`   └── Transport: HTTP`);
      console.log(`   └── Port: ${port}`);
      console.log(`   └── GraphQL URL: ${this.graphqlUrl}`);
      console.log(`   └── Authentication: ${this.client.requestConfig.headers?.Authorization ? 'Bearer Token' : 'None'}`);
      console.log(`📡 MCP endpoint: http://localhost:${port}/mcp`);
      console.log(`📋 Ready to accept MCP requests...`);
    });
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    transport: 'stdio',
    port: 3000,
    queryPrefix: '',
    mutationPrefix: '',
    graphqlUrl: process.env.GRAPHQL_URL,
    token: GRAPHQL_TOKEN
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
      case '--query-prefix':
      case '-q':
        config.queryPrefix = args[++i];
        break;
      case '--mutation-prefix':
      case '-m':
        config.mutationPrefix = args[++i];
        break;
      case '--graphql-url':
      case '-u':
        config.graphqlUrl = args[++i];
        break;
      case '--token':
      case '-T':
        config.token = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
GraphQL MCP Server

Usage: node src/index.js [options]

Options:
  -t, --transport <type>     Transport type: stdio or http (default: stdio)
  -p, --port <number>        HTTP port (default: 3000)
  -q, --query-prefix <str>   Prefix for query tools (default: none)
  -m, --mutation-prefix <str> Prefix for mutation tools (default: none)
  -u, --graphql-url <url>    GraphQL endpoint URL
  -T, --token <token>        Bearer token for authentication
  -h, --help                 Show this help message

Environment Variables:
  GRAPHQL_URL            GraphQL endpoint URL (required if not provided via --graphql-url)
  GRAPHQL_TOKEN          Bearer token for authentication (optional)

Examples:
  node src/index.js -u https://api.example.com/graphql  # Specify GraphQL URL
  node src/index.js -t http -u https://api.example.com/graphql  # HTTP transport
  node src/index.js -u https://api.example.com/graphql -T abc123  # With Bearer token
  node src/index.js -q 'query_' -m 'mutation_' -u https://api.example.com/graphql  # With prefixes
  GRAPHQL_URL=https://api.example.com/graphql node src/index.js  # Using env var
`);
        process.exit(0);
        break;
    }
  }

  if (!['stdio', 'http'].includes(config.transport)) {
    console.error('Error: Transport must be "stdio" or "http"');
    process.exit(1);
  }

  if (!config.graphqlUrl) {
    console.error('Error: GraphQL URL is required. Provide via --graphql-url argument or GRAPHQL_URL environment variable');
    process.exit(1);
  }

  return config;
}

const config = parseArgs();
const graphqlServer = new GraphQLMCPServer(config.graphqlUrl, config.queryPrefix, config.mutationPrefix, config.token);
graphqlServer.run(config.transport, config.port).catch(console.error);