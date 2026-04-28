/**
 * Convert a Zod schema to JSON Schema for MCP tool registration.
 *
 * The MCP SDK expects inputSchema as plain JSON Schema objects.
 * This is a lightweight converter that handles the subset of Zod
 * types used by our tool definitions.
 */

import type { z } from 'zod';

export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Use Zod's built-in JSON Schema generation if available,
  // otherwise fall back to a simple description-based schema
  try {
    // Zod 3.x has a .describe() and we can use the shape
    const zodObj = schema as z.ZodObject<z.ZodRawShape>;
    if ('shape' in zodObj && typeof zodObj.shape === 'object') {
      const shape = zodObj.shape as Record<string, z.ZodType>;
      const properties: Record<string, Record<string, unknown>> = {};
      const required: string[] = [];

      for (const [key, fieldSchema] of Object.entries(shape)) {
        properties[key] = zodFieldToJsonSchema(fieldSchema);
        if (!isOptional(fieldSchema)) {
          required.push(key);
        }
      }

      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }
  } catch {
    // Fall through to default
  }

  return { type: 'object', properties: {} };
}

function zodFieldToJsonSchema(field: z.ZodType): Record<string, unknown> {
  const desc = field.description;
  const inner = unwrapOptional(field);
  const typeName = (inner as { _def?: { typeName?: string } })._def?.typeName ?? '';

  switch (typeName) {
    case 'ZodString':
      return { type: 'string', ...(desc ? { description: desc } : {}) };

    case 'ZodNumber':
      return { type: 'number', ...(desc ? { description: desc } : {}) };

    case 'ZodBoolean':
      return { type: 'boolean', ...(desc ? { description: desc } : {}) };

    case 'ZodEnum': {
      const values = (inner as { _def?: { values?: string[] } })._def?.values ?? [];
      return { type: 'string', enum: values, ...(desc ? { description: desc } : {}) };
    }

    case 'ZodArray':
      return {
        type: 'array',
        items: { type: 'string' },
        ...(desc ? { description: desc } : {}),
      };

    default:
      return { type: 'string', ...(desc ? { description: desc } : {}) };
  }
}

function isOptional(field: z.ZodType): boolean {
  const typeName = (field as { _def?: { typeName?: string } })._def?.typeName ?? '';
  return typeName === 'ZodOptional' || typeName === 'ZodDefault';
}

function unwrapOptional(field: z.ZodType): z.ZodType {
  const def = (field as { _def?: { typeName?: string; innerType?: z.ZodType } })._def;
  if (def?.typeName === 'ZodOptional' && def.innerType) {
    return def.innerType;
  }
  return field;
}
