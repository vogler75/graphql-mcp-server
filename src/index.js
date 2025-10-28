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
          resources: {
            listChanged: true,
          },
        },
      }
    );
  }

  async loadExposedConfig() {
    try {
      const fileContent = await fs.readFile(this.exposedConfigPath, 'utf8');
      this.exposedConfig = yaml.parse(fileContent);
      console.log('✅ Loaded exposed.yaml configuration');
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.error('❌ exposed.yaml not found - it is required');
        throw error;
      } else {
        console.error('❌ Error loading exposed.yaml:', error);
        throw error;
      }
    }
  }

  getNestedField(fields, fieldPath) {
    // Navigate through nested fields using dot notation
    // e.g., "api.dp.get" -> follows api -> dp -> get
    const pathParts = fieldPath.split('.');
    let currentType = null;

    for (let i = 0; i < pathParts.length; i++) {
      const fieldName = pathParts[i];
      const field = fields[fieldName];

      if (!field) {
        return null;
      }

      if (i === pathParts.length - 1) {
        // Last part - return the field
        return field;
      }

      // Navigate to next level
      const baseType = this.getBaseType(field.type);
      if (!isObjectType(baseType)) {
        return null;
      }

      fields = baseType.getFields();
    }

    return null;
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

  async setupResources() {
    try {
      const resourcesDir = path.join(process.cwd(), 'resources');

      // Check if resources directory exists
      let dirExists = true;
      try {
        await fs.access(resourcesDir);
      } catch {
        dirExists = false;
      }

      if (!dirExists) {
        console.log('📁 Resources directory not found - skipping resource setup');
        return;
      }

      // Read all files in the resources directory
      const files = await fs.readdir(resourcesDir);
      const markdownFiles = files.filter(file => file.endsWith('.md'));

      if (markdownFiles.length === 0) {
        console.log('📁 No markdown files found in resources directory');
        return;
      }

      console.log(`🔍 Setting up ${markdownFiles.length} resource(s) from resources/...`);

      // Load all markdown files and register them as resources
      for (const file of markdownFiles) {
        try {
          const filePath = path.join(resourcesDir, file);
          const content = await fs.readFile(filePath, 'utf8');

          // Extract resource name from filename (without .md extension)
          const resourceName = file.replace(/\.md$/, '');

          // Extract the header (first line starting with #) as the display name
          const lines = content.split('\n');
          let displayName = resourceName;
          for (const line of lines) {
            if (line.startsWith('#')) {
              displayName = line.replace(/^#+\s*/, '').trim();
              break;
            }
          }

          // Create resource URI
          const resourceUri = `resources://${resourceName}`;

          // Register the resource with the correct signature: registerResource(name, uri, config, readCallback)
          this.server.registerResource(
            displayName,  // name (used for display)
            resourceUri,  // uri (the resource identifier)
            {
              description: `Resource: ${displayName}`,
              mimeType: 'text/markdown',
            },
            async () => {
              console.log(`📖 Resource read requested for: ${resourceUri}`);
              return {
                contents: [
                  {
                    uri: resourceUri,
                    mimeType: 'text/markdown',
                    text: content,
                  },
                ],
              };
            }
          );

          console.log(`✅ Registered resource: ${resourceUri} (${displayName})`);
        } catch (error) {
          console.error(`❌ Failed to register resource ${file}:`, error.message);
        }
      }

    } catch (error) {
      console.error('Error in setupResources:', error);
      throw error;
    }
  }

  async setupTools() {
    try {
      // Load exposed configuration
      await this.loadExposedConfig();

      if (!this.schema) {
        await this.fetchSchema();
      }

      if (!this.schema) {
        throw new Error('Schema is null after fetch attempt');
      }

      const queryType = this.schema.getQueryType();
      const mutationType = this.schema.getMutationType();

      // Build a set of all registered tool names to detect conflicts
      const registeredToolNames = new Set();

      // Process Queries from exposed.yaml
      if (queryType && this.exposedConfig.exposed.queries && this.exposedConfig.exposed.queries.length > 0) {
        const fields = queryType.getFields();
        console.log(`🔍 Setting up ${this.exposedConfig.exposed.queries.length} configured queries...`);

        for (const fieldPath of this.exposedConfig.exposed.queries) {
          try {
            const field = this.getNestedField(fields, fieldPath);

            if (!field) {
              console.error(`❌ Query field not found in schema: ${fieldPath}`);
              continue;
            }

            const toolName = `${this.queryPrefix}${fieldPath.replace(/\./g, '_')}`;
            const inputSchema = this.generateInputSchema(field.args);

            if (!inputSchema || typeof inputSchema !== 'object') {
              console.error(`❌ Invalid input schema for ${toolName}:`, inputSchema);
              continue;
            }

            const pathDisplay = fieldPath.split('.').join(' > ');
            this.server.registerTool(
              toolName,
              {
                title: `GraphQL Query: ${pathDisplay}`,
                description: field.description || `Execute GraphQL query: ${this.getFieldDescription(field)}`,
                inputSchema: inputSchema,
              },
              async (args) => {
                try {
                  // Build nested query that wraps through all parent fields
                  const pathParts = fieldPath.split('.');
                  const lastFieldName = pathParts[pathParts.length - 1];

                  const variableDefinitions = field.args
                    .map((arg) => `$${arg.name}: ${this.getTypeDescription(arg.type)}`)
                    .join(', ');
                  const variableUsage = field.args
                    .map((arg) => `${arg.name}: $${arg.name}`)
                    .join(', ');
                  const selectionSet = this.generateSelectionSet(field.type);

                  // Build nested query structure from inside out
                  let innerQuery = `${lastFieldName}${variableUsage ? `(${variableUsage})` : ''}${selectionSet ? ` { ${selectionSet} }` : ''}`;

                  // Wrap with parent fields
                  for (let i = pathParts.length - 2; i >= 0; i--) {
                    innerQuery = `${pathParts[i]} { ${innerQuery} }`;
                  }

                  const query = `
                    query ${lastFieldName}${variableDefinitions ? `(${variableDefinitions})` : ''} {
                      ${innerQuery}
                    }
                  `;

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
                  console.error(`❌ GraphQL query ${fieldPath} failed:`, error);
                  throw new Error(`GraphQL query failed: ${error.message}`);
                }
              }
            );
            registeredToolNames.add(toolName);
            console.log(`✅ Registered query: ${fieldPath}`);
          } catch (error) {
            console.error(`❌ Failed to register query ${fieldPath}:`, error.message);
          }
        }
      }

      // Process Mutations from exposed.yaml
      if (mutationType && this.exposedConfig.exposed.mutations && this.exposedConfig.exposed.mutations.length > 0) {
        const fields = mutationType.getFields();
        console.log(`🔍 Setting up ${this.exposedConfig.exposed.mutations.length} configured mutations...`);

        for (const fieldPath of this.exposedConfig.exposed.mutations) {
          try {
            const field = this.getNestedField(fields, fieldPath);

            if (!field) {
              console.error(`❌ Mutation field not found in schema: ${fieldPath}`);
              continue;
            }

            let toolName = `${this.mutationPrefix}${fieldPath.replace(/\./g, '_')}`;

            // If there's a naming conflict with a registered tool, add a _mutation suffix
            if (registeredToolNames.has(toolName)) {
              toolName = `${toolName}_mutation`;
              console.log(`⚠️  Mutation name conflicts with existing tool, renamed to: ${toolName}`);
            }

            const inputSchema = this.generateInputSchema(field.args);

            if (!inputSchema || typeof inputSchema !== 'object') {
              console.error(`❌ Invalid input schema for ${toolName}:`, inputSchema);
              continue;
            }

            const pathDisplay = fieldPath.split('.').join(' > ');
            this.server.registerTool(
              toolName,
              {
                title: `GraphQL Mutation: ${pathDisplay}`,
                description: field.description || `Execute GraphQL mutation: ${this.getFieldDescription(field)}`,
                inputSchema: inputSchema,
              },
              async (args) => {
                try {
                  // Build nested query that wraps through all parent fields
                  const pathParts = fieldPath.split('.');
                  const lastFieldName = pathParts[pathParts.length - 1];

                  const variableDefinitions = field.args
                    .map((arg) => `$${arg.name}: ${this.getTypeDescription(arg.type)}`)
                    .join(', ');
                  const variableUsage = field.args
                    .map((arg) => `${arg.name}: $${arg.name}`)
                    .join(', ');
                  const selectionSet = this.generateSelectionSet(field.type);

                  // Build nested query structure from inside out
                  let innerQuery = `${lastFieldName}${variableUsage ? `(${variableUsage})` : ''}${selectionSet ? ` { ${selectionSet} }` : ''}`;

                  // Wrap with parent fields
                  for (let i = pathParts.length - 2; i >= 0; i--) {
                    innerQuery = `${pathParts[i]} { ${innerQuery} }`;
                  }

                  const query = `
                    mutation ${lastFieldName}${variableDefinitions ? `(${variableDefinitions})` : ''} {
                      ${innerQuery}
                    }
                  `;

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
                  console.error(`❌ GraphQL mutation ${fieldPath} failed:`, error);
                  throw new Error(`GraphQL mutation failed: ${error.message}`);
                }
              }
            );
            registeredToolNames.add(toolName);
            console.log(`✅ Registered mutation: ${fieldPath}`);
          } catch (error) {
            console.error(`❌ Failed to register mutation ${fieldPath}:`, error.message);
          }
        }
      }
    } catch (error) {
      console.error('Error in setupTools:', error);
      throw error;
    }
  }

  async run(transport = 'stdio', port = 3000, host = '0.0.0.0') {
    // Setup resources first (before tools and transport)
    await this.setupResources();

    // Setup tools
    await this.setupTools();

    if (transport === 'http') {
      await this.runHttpServer(port, host);
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

  async runHttpServer(port, host = '0.0.0.0') {
    const app = express();
    app.use(express.json());

    // Map to store transports by session ID
    const transports = {};

    // Authentication middleware
    const authToken = process.env.AUTH_TOKEN;
    if (authToken) {
      app.use((req, res, next) => {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          console.log(`🚫 [${new Date().toISOString()}] Authentication failed - Missing Bearer token`);
          return res.status(401).json({
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: 'Unauthorized: Bearer token required',
            },
            id: null,
          });
        }

        const token = authHeader.substring(7); // Remove 'Bearer ' prefix
        if (token !== authToken) {
          console.log(`🚫 [${new Date().toISOString()}] Authentication failed - Invalid token`);
          return res.status(401).json({
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: 'Unauthorized: Invalid token',
            },
            id: null,
          });
        }

        next();
      });
    }

    app.post('/mcp', async (req, res) => {
      const timestamp = new Date().toISOString();
      const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
      const userAgent = req.get('User-Agent') || 'unknown';
      const method = req.body?.method || 'unknown';
      const requestId = req.body?.id || 'N/A';
      const sessionId = req.headers['mcp-session-id'];

      console.log(`📨 [${timestamp}] MCP Request Received`);
      console.log(`   └── Method: ${method}`);
      console.log(`   └── Request ID: ${requestId}`);
      console.log(`   └── Session ID: ${sessionId || 'new'}`);
      console.log(`   └── Client IP: ${clientIP}`);
      console.log(`   └── User Agent: ${userAgent.substring(0, 50)}${userAgent.length > 50 ? '...' : ''}`);

      try {
        let transport;

        if (sessionId && transports[sessionId]) {
          // Reuse existing transport for this session
          transport = transports[sessionId];
          console.log(`   └── Reusing transport for session ${sessionId}`);
        } else {
          // Create new transport for this request
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });

          // Connect the server to this transport
          await this.server.connect(transport);

          // Store transport by session ID if provided
          if (sessionId) {
            transports[sessionId] = transport;
            console.log(`   └── Created new transport for session ${sessionId}`);
          } else {
            console.log(`   └── Created new stateless transport`);
          }

          // Set up cleanup when transport closes
          transport.onclose = () => {
            if (sessionId && transports[sessionId]) {
              console.log(`🔌 [${new Date().toISOString()}] Transport closed for session ${sessionId}`);
              delete transports[sessionId];
            }
          };
        }

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

    app.listen(port, host, () => {
      const timestamp = new Date().toISOString();
      console.log(`🚀 [${timestamp}] GraphQL MCP Server Started`);
      console.log(`   └── Transport: HTTP`);
      console.log(`   └── Host: ${host}`);
      console.log(`   └── Port: ${port}`);
      console.log(`   └── GraphQL URL: ${this.graphqlUrl}`);
      console.log(`   └── GraphQL Authentication: ${this.client.requestConfig.headers?.Authorization ? 'Bearer Token' : 'None'}`);
      console.log(`   └── MCP Authentication: ${authToken ? 'Bearer Token Required' : 'None (Open Access)'}`);
      console.log(`📡 MCP endpoint: http://${host}:${port}/mcp`);
      console.log(`📋 Ready to accept MCP requests...`);
    });
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    transport: 'stdio',
    port: 3000,
    host: '0.0.0.0',
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
      case '--host':
      case '-H':
        config.host = args[++i];
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
  -H, --host <address>       HTTP host address (default: 0.0.0.0)
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
  node src/index.js -t http -H 0.0.0.0 -u https://api.example.com/graphql  # Listen on all interfaces
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
graphqlServer.run(config.transport, config.port, config.host).catch(console.error);