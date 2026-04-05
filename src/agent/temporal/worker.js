import { Worker, NativeConnection } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { fileURLToPath } from 'url';
import path from 'path';
import { createActivities } from './activities/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Starts a Temporal worker embedded in the agent subprocess and returns
// a client for launching / signaling workflows.
//
// The worker runs in the background (worker.run() is not awaited here).
// Call worker.shutdown() on process exit.
export async function createAndRunWorker(agent, settings) {
    const agentName = agent.name;
    const taskQueue = `mindcraft-${agentName}`;

    const [workerConnection, clientConnection] = await Promise.all([
        NativeConnection.connect({ address: settings.temporal_address }),
        Connection.connect({ address: settings.temporal_address }),
    ]);

    const client = new Client({
        connection: clientConnection,
        namespace: settings.temporal_namespace,
    });

    const worker = await Worker.create({
        connection: workerConnection,
        namespace: settings.temporal_namespace,
        // workflowsPath is the single entrypoint bundled by Temporal's webpack wrapper.
        // All workflows that may run on this task queue must be exported from this file.
        workflowsPath: path.join(__dirname, 'workflows', 'index.js'),
        activities: createActivities(agent),
        taskQueue,
    });

    // Run in background — errors are logged but don't crash the agent process.
    worker.run().catch((err) => {
        console.error(`[Temporal] Worker for agent "${agentName}" crashed:`, err);
    });

    return { worker, client, taskQueue };
}
