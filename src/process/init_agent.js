import { Agent } from '../agent/agent.js';
import { serverProxy } from '../agent/mindserver_proxy.js';
import settings from '../agent/settings.js';
import yargs from 'yargs';

const args = process.argv.slice(2);
if (args.length < 1) {
    console.log('Usage: node init_agent.js -n <agent_name> -p <port> -l <load_memory> -m <init_message> -c <count_id>');
    process.exit(1);
}

const argv = yargs(args)
    .option('name', {
        alias: 'n',
        type: 'string',
        description: 'name of agent'
    })
    .option('load_memory', {
        alias: 'l',
        type: 'boolean',
        description: 'load agent memory from file on startup'
    })
    .option('init_message', {
        alias: 'm',
        type: 'string',
        description: 'automatically prompt the agent on startup'
    })
    .option('count_id', {
        alias: 'c',
        type: 'number',
        default: 0,
        description: 'identifying count for multi-agent scenarios',
    })
    .option('port', {
        alias: 'p',
        type: 'number',
        description: 'port of mindserver'
    })
    .argv;

(async () => {
    try {
        console.log('Connecting to MindServer');
        await serverProxy.connect(argv.name, argv.port);
        console.log('Starting agent');
        const agent = new Agent();
        serverProxy.setAgent(agent);

        // Start Temporal BEFORE agent.start() so that the workflow handle is ready
        // when the bot's login/spawn events fire (which happen during agent.start()).
        // agent.name is pre-set from argv.name so the task queue name is known.
        if (settings.temporal_enabled) {
            agent.name = argv.name; // set early; agent.start() will re-confirm from profile
            const { createAndRunWorker } = await import('../agent/temporal/worker.js');
            const { worker, client, taskQueue } = await createAndRunWorker(agent, settings);

            agent.temporalWorker = worker;
            agent.temporalClient = client;

            // Use a stable workflow ID so we can reliably terminate the previous session.
            // Terminating the lifecycle also cascades to any running GoalPursuit children
            // (PARENT_CLOSE_POLICY_TERMINATE), preventing stale activities from executing
            // on the new worker before the agent is initialized.
            const workflowId = `agent-lifecycle-${agent.name}`;
            try {
                await client.workflow.getHandle(workflowId).terminate('agent restarted');
                console.log(`[Temporal] Terminated previous lifecycle: ${workflowId}`);
            } catch (_) { /* no previous run — that's fine */ }

            const handle = await client.workflow.start('AgentLifecycleWorkflow', {
                taskQueue,
                workflowId,
                args: [{ agentName: agent.name, sessionCount: 0 }],
            });
            agent.temporalWorkflowHandle = handle;
            console.log(`[Temporal] Lifecycle workflow started: ${workflowId}`);

            process.on('beforeExit', () => worker.shutdown());
        }

        await agent.start(argv.load_memory, argv.init_message, argv.count_id);
    } catch (error) {
        console.error('Failed to start agent process:');
        console.error(error.message);
        console.error(error.stack);
        process.exit(1);
    }
})();
