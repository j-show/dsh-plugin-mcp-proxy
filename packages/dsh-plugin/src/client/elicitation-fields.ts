/** Normalize MCP's primitive form schemas into presentation data. */
import { objectValue } from './response.ts'

/** One labeled string choice; values preserve the MCP schema's original strings. */
export interface ElicitationChoice { readonly label: string; readonly value: string }
/** Presentation-only field metadata. */
export interface ElicitationField {
  readonly name: string
  readonly label: string
  readonly description?: string
  readonly kind: 'text' | 'number' | 'boolean' | 'select' | 'multi'
  readonly required: boolean
  readonly integer: boolean
  readonly choices: readonly ElicitationChoice[]
  readonly initial: unknown
}
function choices(schema: Record<string, unknown>): ElicitationChoice[] {
  if (Array.isArray(schema['enum'])) return schema['enum'].map((value: unknown, index) => {
    if (typeof value !== 'string') throw new Error('Invalid form choice')
    const names = schema['enumNames']
    const label = Array.isArray(names) && typeof names[index] === 'string' ? names[index] : value
    return { value, label }
  })
  const alternatives = schema['oneOf'] ?? schema['anyOf']
  if (!Array.isArray(alternatives)) return []
  return alternatives.map((value: unknown) => {
    const entry = objectValue(value)
    if (typeof entry['const'] !== 'string') throw new Error('Invalid form choice')
    return { value: entry['const'], label: typeof entry['title'] === 'string' ? entry['title'] : entry['const'] }
  })
}
/**
 * Convert the supported elicitation schema into validated form fields.
 * @param schema - wire-validated object schema.
 * @returns stable primitive field presentation; unsupported fields fail explicitly.
 */
export function elicitationFields(schema: Record<string, unknown>): ElicitationField[] {
  if (schema['type'] !== 'object') throw new Error('Invalid form schema')
  const properties = objectValue(schema['properties'])
  const required = schema['required']
  if (required !== undefined && (!Array.isArray(required) || required.some(value => typeof value !== 'string'))) {
    throw new Error('Invalid required form fields')
  }
  return Object.entries(properties).map(([name, value]) => {
    const field = objectValue(value)
    const type = field['type']
    const options = choices(type === 'array' ? objectValue(field['items']) : field)
    const kind = type === 'array' ? 'multi' : type === 'boolean' ? 'boolean' : type === 'number' || type === 'integer'
      ? 'number' : type === 'string' ? options.length > 0 ? 'select' : 'text' : undefined
    if (kind === undefined || (kind === 'multi' && options.length === 0)) throw new Error('Unsupported elicitation field')
    const mandatory = Array.isArray(required) && required.includes(name)
    return { name, kind, choices: options, label: typeof field['title'] === 'string' ? field['title'] : name,
      ...(typeof field['description'] === 'string' ? { description: field['description'] } : {}),
      required: mandatory, integer: type === 'integer',
      initial: field['default'] ?? (mandatory
        ? kind === 'boolean' ? false : kind === 'multi' ? [] : kind === 'text' ? '' : undefined : undefined),
    }
  })
}
