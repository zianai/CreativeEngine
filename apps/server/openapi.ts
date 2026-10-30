import { z } from 'zod';
import { jsonSchemas } from '../../packages/contracts/index.js';
import { TradeCaseRequestSchema } from '../../packages/integrations/tradecase/index.js';

type JsonSchema = Record<string, unknown>;
const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const jsonResponse = (description: string, schema: JsonSchema) => ({
  description,
  content: { 'application/json': { schema } },
});
const errors = {
  '400': jsonResponse('Invalid request or policy violation', ref('Error')),
  '401': jsonResponse('A configured local API bearer token is required', ref('Error')),
  '403': jsonResponse('Untrusted browser origin or host', ref('Error')),
  '404': jsonResponse('Entity does not exist', ref('Error')),
  '409': jsonResponse('State, input evidence or idempotency conflict', ref('Error')),
  '500': jsonResponse('Internal failure; inspect durable task status before retry', ref('Error')),
};
const pagination = [
  { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
];
const projectFilter = { name: 'project_id', in: 'query', schema: { type: 'string' } };
const page = (item: JsonSchema): JsonSchema => ({
  type: 'object',
  required: ['items', 'total', 'offset', 'limit'],
  properties: {
    items: { type: 'array', items: item },
    total: { type: 'integer', minimum: 0 },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
});

/** OpenAPI is generated from the same versioned Zod contracts used by every entrypoint. */
export function openapi() {
  const schemas: Record<string, unknown> = {
    ...jsonSchemas(),
    ProjectInput: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', maxLength: 4000, default: '' },
        product_id: { type: 'string', maxLength: 200 },
      },
    },
    Error: {
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} },
        },
      },
    },
    Health: {
      type: 'object',
      required: ['status', 'schema_version', 'storage', 'worker'],
      properties: {
        status: { const: 'ok' },
        schema_version: { const: '1.0.0' },
        storage: { const: 'sqlite-wal' },
        worker: { type: 'boolean' },
        real_provider_status: { type: 'string' },
      },
    },
    Dashboard: {
      type: 'object',
      properties: Object.fromEntries(
        ['projects', 'batches', 'assets', 'review_pending', 'cost_usd', 'reserved_usd'].map((key) => [
          key,
          { type: 'number', minimum: 0 },
        ]),
      ),
    },
    Provider: {
      type: 'object',
      required: ['id', 'capabilities', 'health'],
      properties: {
        id: { type: 'string' },
        capabilities: {
          type: 'object',
          required: ['generate', 'edit', 'exactSize', 'paid', 'maxConcurrency'],
          properties: {
            generate: { type: 'boolean' },
            edit: { type: 'boolean' },
            exactSize: { type: 'boolean' },
            paid: { type: 'boolean' },
            maxConcurrency: { type: 'integer', minimum: 1 },
          },
          additionalProperties: true,
        },
        health: { type: 'object', additionalProperties: true },
      },
    },
    Skill: {
      type: 'object',
      required: ['id', 'version', 'name', 'description', 'digest', 'qa_profile'],
      properties: {
        id: { type: 'string' },
        version: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        digest: { type: 'string', minLength: 64, maxLength: 64 },
        qa_profile: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: true,
    },
    Event: {
      type: 'object',
      required: ['seq', 'id', 'type', 'entity_id', 'data', 'created_at'],
      properties: {
        seq: { type: 'integer' },
        id: { type: 'string' },
        type: { type: 'string' },
        entity_id: { type: 'string' },
        data: {},
        created_at: { type: 'string', format: 'date-time' },
      },
    },
    TradeCaseRequest: z.toJSONSchema(TradeCaseRequestSchema, { io: 'input' }),
    TradeCaseResult: {
      type: 'object',
      required: ['batch_id', 'execution_status', 'approved_asset_ids', 'qa_summary', 'export_package'],
      properties: {
        batch_id: { type: 'string' },
        execution_status: { type: 'string' },
        approved_asset_ids: { type: 'array', items: { type: 'string' } },
        qa_summary: {
          type: 'array',
          items: { type: 'object', properties: { asset_id: { type: 'string' }, qa: ref('QAReport') } },
        },
        export_package: { type: 'array', items: ref('ExportPackage') },
      },
    },
  };
  const paths: Record<string, Record<string, unknown>> = {};
  const add = (
    path: string,
    method: 'get' | 'post',
    summary: string,
    response: JsonSchema,
    options: {
      request?: string;
      status?: number;
      list?: boolean;
      filter?: boolean;
      description?: string;
      parameters?: any[];
      binary?: boolean;
      sse?: boolean;
    } = {},
  ) => {
    const parameters: any[] = [
      {
        name: 'X-API-Version',
        in: 'header',
        required: false,
        schema: { type: 'string', enum: ['1.0.0'] },
        description: 'Omission uses v1. An explicitly unsupported version fails with 409 before execution.',
      },
      ...(path.includes('{id}')
        ? [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
        : []),
      ...(options.list ? pagination : []),
      ...(options.filter ? [projectFilter] : []),
      ...(options.parameters ?? []),
    ];
    const status = String(options.status ?? 200);
    paths[path] ??= {};
    paths[path]![method] = {
      operationId: `${method}_${path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}`,
      summary,
      ...(options.description ? { description: options.description } : {}),
      parameters,
      ...(options.request
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref(options.request) } },
            },
          }
        : {}),
      responses: {
        [status]: options.binary
          ? {
              description: summary,
              content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
            }
          : options.sse
            ? {
                description:
                  'SSE stream; each data line contains an Event object. Resume with Last-Event-ID or after.',
                content: { 'text/event-stream': { schema: { type: 'string' } } },
              }
            : jsonResponse(summary, options.list ? page(response) : response),
        ...errors,
      },
    };
  };
  add('/health', 'get', 'Inspect service health without claiming live provider verification', ref('Health'));
  add('/dashboard', 'get', 'Read project and budget totals', ref('Dashboard'));
  add('/providers', 'get', 'Read declared capabilities and runtime health', ref('Provider'), { list: true });
  add(
    '/delivery-rules',
    'get',
    'List versioned sourced delivery-rule configurations',
    ref('DeliveryRuleSnapshot'),
    {
      list: true,
      description:
        'Rules distinguish operator-defined requirements from official source claims. The bundled custom-square rule is user_defined and does not assert marketplace compliance.',
    },
  );
  add('/skills', 'get', 'List validated versioned Skill bundles', ref('Skill'), { list: true });
  add('/projects', 'get', 'List projects', ref('Project'), { list: true });
  add('/projects', 'post', 'Create an independent visual project', ref('Project'), {
    request: 'ProjectInput',
    status: 201,
  });
  add('/projects/{id}', 'get', 'Get project', ref('Project'));
  add('/truth-snapshots', 'get', 'List immutable Product Truth snapshots', ref('ProductTruthSnapshot'), {
    list: true,
    filter: true,
  });
  add('/truth-snapshots', 'post', 'Create a new source-backed truth snapshot', ref('ProductTruthSnapshot'), {
    request: 'ProductTruthSnapshot',
    status: 201,
    description:
      'Input id is ignored. Facts must cite authorized original evidence with a matching source_version. Generated assets cannot establish facts.',
  });
  add('/truth-snapshots/{id}', 'get', 'Get an exact immutable truth snapshot', ref('ProductTruthSnapshot'));
  add(
    '/assets',
    'get',
    'List source and production assets',
    { anyOf: [ref('SourceAsset'), ref('VisualAsset')] },
    { list: true, filter: true },
  );
  add('/assets/import', 'post', 'Import authorized original bytes', ref('SourceAsset'), {
    request: 'SourceAssetImport',
    status: 201,
    description:
      'Raw base64 upload, maximum 20 MiB decoded bytes. No local file paths or remote URLs. Images: PNG, JPEG, WebP. Evidence documents: PDF or plain text.',
  });
  add('/assets/{id}', 'get', 'Get an asset with provenance, QA and review history', {
    anyOf: [ref('SourceAsset'), ref('VisualAsset')],
  });
  add('/assets/{id}/file', 'get', 'Download original immutable asset bytes', {}, { binary: true });
  add('/assets/{id}/review', 'post', 'Record explicit human approval or rejection', ref('VisualAsset'), {
    request: 'ReviewInput',
    description:
      'A declared reviewer is an audit record within the local operator trust boundary. Blocking QA cannot be overridden by approval.',
  });
  add('/briefs', 'post', 'Save a structured creative brief', ref('CreativeBrief'), {
    request: 'CreativeBriefInput',
    status: 201,
  });
  add('/briefs/{id}', 'get', 'Get saved creative brief', ref('CreativeBrief'));
  add('/briefs/{id}/plan', 'post', 'Plan without paid provider calls', ref('VisualPlan'), {
    description:
      'Business-policy blockers are returned in strategy=blocked and blocked_reasons. Execution is a separate budget-authorized request.',
  });
  add('/plans/{id}', 'get', 'Get immutable visual production plan', ref('VisualPlan'));
  add('/batches', 'get', 'List batches and their tasks', ref('Batch'), { list: true, filter: true });
  add('/batches', 'post', 'Queue a validated plan and return durable task IDs', ref('Batch'), {
    request: 'BatchInput',
    status: 202,
    parameters: [
      { name: 'Idempotency-Key', in: 'header', schema: { type: 'string', minLength: 1, maxLength: 200 } },
    ],
    description:
      'Budget is an explicit USD ceiling. Paid generation and optional paid vision_review require authorize_paid=true. A repeated idempotency key with changed inputs returns conflict. No synchronous generation in this route.',
  });
  add('/batches/{id}', 'get', 'Read batch state, cost and tasks', ref('Batch'));
  for (const action of ['cancel', 'pause', 'resume'])
    add(
      `/batches/{id}/${action}`,
      'post',
      `${action} a batch through validated state transitions`,
      ref('Batch'),
      { description: 'Cancellation is terminal. Resume does not re-submit ambiguous paid attempts.' },
    );
  add('/tasks/{id}', 'get', 'Get a task with execution attempt history', {
    allOf: [
      ref('VisualTask'),
      { type: 'object', properties: { attempts: { type: 'array', items: ref('ExecutionAttempt') } } },
    ],
  });
  add('/tasks/{id}/revise', 'post', 'Create an immutable child revision and batch', ref('Batch'), {
    request: 'Revision',
    status: 202,
    description:
      'Revision cannot expand allowed changes. Deterministic edits require a supported background or cutout color instruction; unsupported requests return REVISION_NEEDS_INPUT.',
  });
  add('/exports', 'get', 'List export history without local filesystem paths', ref('ExportPackage'), {
    list: true,
    filter: true,
  });
  add(
    '/tasks/{id}/reconcile',
    'post',
    'Record an operator-confirmed outcome for an ambiguous external attempt',
    ref('VisualTask'),
    {
      request: 'ReconciliationInput',
      description:
        'Requires the operator reviewer and explicit evidence from the provider. no_charge records confirmed absence of a charge; failed_charged records the confirmed charge. Never infer no_charge from a timeout.',
    },
  );
  add('/exports', 'post', 'Create an approved-only ZIP and provenance manifest', ref('ExportPackage'), {
    request: 'ExportInput',
    status: 201,
    description:
      'With no asset_ids, export the approved subset. Explicit pending/rejected IDs fail. External delivery manifests redact internal prompts, reviewer notes and withheld facts; internal_review manifests retain local audit detail.',
  });
  add('/exports/{id}', 'get', 'Get export manifest and download URL', ref('ExportPackage'));
  add('/exports/{id}/file', 'get', 'Download ZIP package', {}, { binary: true });
  add('/events', 'get', 'Subscribe to durable state-change events', ref('Event'), {
    sse: true,
    parameters: [
      { name: 'Last-Event-ID', in: 'header', schema: { type: 'integer', minimum: 0 } },
      { name: 'after', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
    ],
  });
  add(
    '/integrations/tradecase/plan',
    'post',
    'Import a TradeCase request and create a dry-run plan',
    ref('VisualPlan'),
    {
      request: 'TradeCaseRequest',
      status: 201,
      description:
        'No direct TradeCase database access. Source external_id values are mapped to engine IDs; external case identity is retained in plan.source. No paid execution occurs.',
    },
  );
  add(
    '/integrations/tradecase/batches/{id}',
    'get',
    'Return approved artifacts and status to TradeCase',
    ref('TradeCaseResult'),
  );
  add('/openapi.json', 'get', 'Read this versioned OpenAPI 3.1 description', { type: 'object' });
  return {
    openapi: '3.1.0',
    info: {
      title: 'Creative Engine',
      version: '1.0.0',
      description:
        'Local-first visual production. API, CLI and MCP share deterministic policy, workflow and asset services.',
    },
    servers: [{ url: 'http://127.0.0.1:4310/v1' }],
    security: [{}, { LocalToken: [] }],
    paths,
    components: {
      securitySchemes: {
        LocalToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'Required on /v1 routes only when CREATIVE_API_TOKEN is configured.',
        },
      },
      schemas,
    },
  };
}
