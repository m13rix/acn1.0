import express from 'express';
import { createServer } from 'node:http';
import open from 'open';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analysis, events, nodes, paths, strategies } from '../index.js';

type StrategyCall =
  | 'strategy.strategies.create'
  | 'strategy.strategies.list'
  | 'strategy.strategies.get'
  | 'strategy.strategies.remove'
  | 'strategy.paths.create'
  | 'strategy.paths.list'
  | 'strategy.paths.get'
  | 'strategy.paths.remove'
  | 'strategy.paths.validate'
  | 'strategy.nodes.add'
  | 'strategy.nodes.list'
  | 'strategy.nodes.update'
  | 'strategy.nodes.remove'
  | 'strategy.events.add'
  | 'strategy.events.list'
  | 'strategy.events.update'
  | 'strategy.events.remove'
  | 'strategy.analysis.analyzePath'
  | 'strategy.analysis.probabilityToReachGoal'
  | 'strategy.analysis.expectedStepsToGoal'
  | 'strategy.analysis.expectedStateDelta'
  | 'strategy.analysis.hittingTimeDistribution'
  | 'strategy.analysis.distributionAtStep';

interface CallDefinition {
  name: StrategyCall;
  group: string;
  summary: string;
  invoke: (args: unknown[]) => Promise<unknown>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLIENT_DIR = join(__dirname, 'client');
const PORT = Number(process.env['STRATEGY_VIZ_PORT'] || 2012);
const SHOULD_OPEN = process.env['STRATEGY_VIZ_OPEN'] !== '0';

function asString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

function asNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number.`);
  }
  return value;
}

function asObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArgs(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('args must be an array.');
  }
  return value;
}

const callDefinitions: CallDefinition[] = [
  {
    name: 'strategy.strategies.create',
    group: 'Strategies',
    summary: 'Create a strategy container before working with paths.',
    invoke: async (args) => strategies.create(
      asString(args[0], 'name'),
      typeof args[1] === 'undefined' ? undefined : String(args[1] ?? '')
    ),
  },
  {
    name: 'strategy.strategies.list',
    group: 'Strategies',
    summary: 'List available strategies.',
    invoke: async () => strategies.list(),
  },
  {
    name: 'strategy.strategies.get',
    group: 'Strategies',
    summary: 'Load a full strategy, including all paths.',
    invoke: async (args) => strategies.get(asString(args[0], 'strategyId')),
  },
  {
    name: 'strategy.strategies.remove',
    group: 'Strategies',
    summary: 'Delete a strategy and all of its stored data.',
    invoke: async (args) => strategies.remove(asString(args[0], 'strategyId')),
  },
  {
    name: 'strategy.paths.create',
    group: 'Paths',
    summary: 'Create a path with an auto-created root node.',
    invoke: async (args) => paths.create(
      asString(args[0], 'strategyId'),
      asObject(args[1], 'input') as { name: string; description?: string; rootName?: string }
    ),
  },
  {
    name: 'strategy.paths.list',
    group: 'Paths',
    summary: 'List paths in a strategy.',
    invoke: async (args) => paths.list(asString(args[0], 'strategyId')),
  },
  {
    name: 'strategy.paths.get',
    group: 'Paths',
    summary: 'Load one path with nodes and events.',
    invoke: async (args) => paths.get(asString(args[0], 'strategyId'), asString(args[1], 'pathId')),
  },
  {
    name: 'strategy.paths.remove',
    group: 'Paths',
    summary: 'Delete one path.',
    invoke: async (args) => paths.remove(asString(args[0], 'strategyId'), asString(args[1], 'pathId')),
  },
  {
    name: 'strategy.paths.validate',
    group: 'Paths',
    summary: 'Validate graph constraints for one path.',
    invoke: async (args) => paths.validate(asString(args[0], 'strategyId'), asString(args[1], 'pathId')),
  },
  {
    name: 'strategy.nodes.add',
    group: 'Nodes',
    summary: 'Add a node to the selected path.',
    invoke: async (args) => nodes.add(
      asString(args[0], 'strategyId'),
      asString(args[1], 'pathId'),
      asObject(args[2], 'input') as { name: string; kind?: 'intermediate' | 'goal' | 'fail'; note?: string }
    ),
  },
  {
    name: 'strategy.nodes.list',
    group: 'Nodes',
    summary: 'List nodes for the selected path.',
    invoke: async (args) => nodes.list(asString(args[0], 'strategyId'), asString(args[1], 'pathId')),
  },
  {
    name: 'strategy.nodes.update',
    group: 'Nodes',
    summary: 'Update node name, kind, or note.',
    invoke: async (args) => nodes.update(
      asString(args[0], 'strategyId'),
      asString(args[1], 'pathId'),
      asString(args[2], 'nodeId'),
      asObject(args[3], 'patch') as { name?: string; kind?: 'intermediate' | 'goal' | 'fail'; note?: string }
    ),
  },
  {
    name: 'strategy.nodes.remove',
    group: 'Nodes',
    summary: 'Remove a node and all connected events.',
    invoke: async (args) => nodes.remove(
      asString(args[0], 'strategyId'),
      asString(args[1], 'pathId'),
      asString(args[2], 'nodeId')
    ),
  },
  {
    name: 'strategy.events.add',
    group: 'Events',
    summary: 'Create a transition between nodes.',
    invoke: async (args) => events.add(
      asString(args[0], 'strategyId'),
      asString(args[1], 'pathId'),
      asObject(args[2], 'input') as {
        fromNodeId: string;
        toNodeId: string;
        name: string;
        probability: number;
        stateDelta: number;
        reason?: string;
      }
    ),
  },
  {
    name: 'strategy.events.list',
    group: 'Events',
    summary: 'List transitions for the selected path.',
    invoke: async (args) => events.list(asString(args[0], 'strategyId'), asString(args[1], 'pathId')),
  },
  {
    name: 'strategy.events.update',
    group: 'Events',
    summary: 'Update transition endpoints or weights.',
    invoke: async (args) => events.update(
      asString(args[0], 'strategyId'),
      asString(args[1], 'pathId'),
      asString(args[2], 'eventId'),
      asObject(args[3], 'patch') as {
        fromNodeId?: string;
        toNodeId?: string;
        name?: string;
        probability?: number;
        stateDelta?: number;
        reason?: string;
      }
    ),
  },
  {
    name: 'strategy.events.remove',
    group: 'Events',
    summary: 'Remove a transition.',
    invoke: async (args) => events.remove(
      asString(args[0], 'strategyId'),
      asString(args[1], 'pathId'),
      asString(args[2], 'eventId')
    ),
  },
  {
    name: 'strategy.analysis.analyzePath',
    group: 'Analysis',
    summary: 'Run the full path analysis bundle.',
    invoke: async (args) => analysis.analyzePath(
      asString(args[0], 'strategyId'),
      asString(args[1], 'pathId'),
      asObject(args[2], 'options') as { maxSteps: number }
    ),
  },
  {
    name: 'strategy.analysis.probabilityToReachGoal',
    group: 'Analysis',
    summary: 'Return success probability within maxSteps.',
    invoke: async (args) => analysis.probabilityToReachGoal(
      asString(args[0], 'strategyId'),
      asString(args[1], 'pathId'),
      asNumber(args[2], 'maxSteps')
    ),
  },
  {
    name: 'strategy.analysis.expectedStepsToGoal',
    group: 'Analysis',
    summary: 'Return conditional expected steps to goal.',
    invoke: async (args) => analysis.expectedStepsToGoal(
      asString(args[0], 'strategyId'),
      asString(args[1], 'pathId'),
      asNumber(args[2], 'maxSteps')
    ),
  },
  {
    name: 'strategy.analysis.expectedStateDelta',
    group: 'Analysis',
    summary: 'Return cumulative expected stateDelta.',
    invoke: async (args) => analysis.expectedStateDelta(
      asString(args[0], 'strategyId'),
      asString(args[1], 'pathId'),
      asNumber(args[2], 'maxSteps')
    ),
  },
  {
    name: 'strategy.analysis.hittingTimeDistribution',
    group: 'Analysis',
    summary: 'Return goal hitting-time distribution.',
    invoke: async (args) => analysis.hittingTimeDistribution(
      asString(args[0], 'strategyId'),
      asString(args[1], 'pathId'),
      asNumber(args[2], 'maxSteps')
    ),
  },
  {
    name: 'strategy.analysis.distributionAtStep',
    group: 'Analysis',
    summary: 'Return node probability distribution for one step.',
    invoke: async (args) => analysis.distributionAtStep(
      asString(args[0], 'strategyId'),
      asString(args[1], 'pathId'),
      asNumber(args[2], 'step')
    ),
  },
];

const callMap = new Map(callDefinitions.map((definition) => [definition.name, definition] as const));

function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: process.env['NODE_ENV'] === 'development' ? error.stack : undefined,
    };
  }

  return {
    message: String(error),
  };
}

async function startServer(): Promise<void> {
  const app = express();
  const server = createServer(app);

  app.use(express.static(CLIENT_DIR));
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/manifest', (_req, res) => {
    res.json({
      ok: true,
      calls: callDefinitions.map(({ name, group, summary }) => ({ name, group, summary })),
    });
  });

  app.post('/api/call', async (req, res) => {
    try {
      const name = asString(req.body?.name, 'name') as StrategyCall;
      const args = asArgs(req.body?.args);
      const definition = callMap.get(name);

      if (!definition) {
        res.status(400).json({
          ok: false,
          error: `Unsupported strategy call "${name}".`,
        });
        return;
      }

      const result = await definition.invoke(args);
      res.json({ ok: true, name, result });
    } catch (error) {
      const serialized = serializeError(error);
      res.status(500).json({
        ok: false,
        error: serialized.message,
        stack: serialized.stack,
      });
    }
  });

  app.use((_req, res) => {
    res.sendFile(join(CLIENT_DIR, 'index.html'));
  });

  server.listen(PORT, async () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Strategy Visualizer running at ${url}`);
    if (SHOULD_OPEN) {
      await open(url);
    }
  });
}

startServer().catch((error) => {
  console.error('Failed to start Strategy Visualizer:', error);
  process.exitCode = 1;
});
