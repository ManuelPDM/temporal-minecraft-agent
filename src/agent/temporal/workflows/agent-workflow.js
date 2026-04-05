import {
    defineSignal,
    defineQuery,
    setHandler,
    condition,
    sleep,
    continueAsNew,
    proxyActivities,
    workflowInfo,
} from '@temporalio/workflow';

/**
 * Consolidates Lifecycle and Goal Pursuit into a single, observable workflow.
 * This ensures the entire Agent's "History" is in one place in the Temporal UI.
 */

const { 
    executeLLMGoalIteration, 
    executeActionActivity, 
    executePassiveThinking, 
    notifyGoalComplete,
    notifyAgentEvent 
} = proxyActivities({
    startToCloseTimeout: '10 minutes',
    heartbeatTimeout: '60 seconds',
    retry: {
        maximumAttempts: 3,
        backoffCoefficient: 1,
    },
});

// Signals
export const agentConnectedSignal = defineSignal('agentConnected');
export const agentSpawnedSignal = defineSignal('agentSpawned');
export const agentDisconnectedSignal = defineSignal('agentDisconnected');
export const updateGoalSignal = defineSignal('updateGoal');
export const pauseSignal = defineSignal('pause');
export const resumeSignal = defineSignal('resume');
export const stopSignal = defineSignal('stop');

// Queries
export const getAgentStatusQuery = defineQuery('getAgentStatus');

export async function MindcraftAgentWorkflow(input) {
    const {
        agentName,
        initialGoal = null,
        iterationCount: startIteration = 0,
        noCommandCount: startNoCommand = 0,
        cooldownMs = 2000,
        passiveThinkingInterval = 10,
    } = input;

    let state = 'BOOTING';
    let currentGoal = initialGoal;
    let iterationCount = startIteration;
    let noCommandCount = startNoCommand;
    let paused = false;
    let stopped = false;
    let lastUsedCommand = false;
    let lastCommand = null;
    let lastActionStatus = null;
    let passiveThinkingCounter = 0;

    const MAX_NO_COMMAND = 3;

    // --- Signal Handlers ---
    setHandler(agentConnectedSignal, () => { state = 'CONNECTING'; });
    setHandler(agentSpawnedSignal, () => { state = 'RUNNING'; });
    setHandler(agentDisconnectedSignal, () => { state = 'DISCONNECTED'; });
    setHandler(updateGoalSignal, (newGoal) => { currentGoal = newGoal; });
    setHandler(pauseSignal, () => { paused = true; });
    setHandler(resumeSignal, () => { paused = false; });
    setHandler(stopSignal, () => { stopped = true; });

    // --- Query Handler ---
    setHandler(getAgentStatusQuery, () => ({
        state,
        paused,
        stopped,
        goal: currentGoal,
        iterationCount,
        noCommandCount,
        lastCommand,
        lastActionStatus,
    }));

    // Logic: Wait for the agent to connect/spawn before starting goal loops
    if (state === 'BOOTING') {
        await condition(() => state === 'CONNECTING' || state === 'RUNNING');
    }

    while (!stopped && state !== 'DISCONNECTED' && noCommandCount < MAX_NO_COMMAND) {
        // Wait if paused
        if (paused) {
            await condition(() => !paused || stopped || state === 'DISCONNECTED', '365 days');
            if (stopped || state === 'DISCONNECTED') break;
        }

        if (!currentGoal) {
            // Idle state: wait for a goal signal if none provided at start
            await condition(() => !!currentGoal || stopped || state === 'DISCONNECTED');
            if (stopped || state === 'DISCONNECTED') break;
        }

        // 1. LLM Iteration
        const result = await executeLLMGoalIteration(currentGoal.description || currentGoal);
        lastUsedCommand = result.used_command;
        
        // 2. Action Execution
        if (result.command) {
            lastCommand = result.command_name ? result.command_name : "Action";
            lastActionStatus = await executeActionActivity(result.command, result.command_name);
        }

        iterationCount++;
        if (result.used_command) {
            noCommandCount = 0;
        } else {
            noCommandCount++;
        }

        // 3. Passive Thinking
        if (passiveThinkingInterval > 0) {
            passiveThinkingCounter++;
            if (passiveThinkingCounter >= passiveThinkingInterval) {
                passiveThinkingCounter = 0;
                await executePassiveThinking();
            }
        }

        // 4. Durability Check: continueAsNew to prevent history bloat
        if (iterationCount >= 200) {
            await continueAsNew({
                agentName,
                initialGoal: currentGoal,
                iterationCount,
                noCommandCount,
                cooldownMs,
                passiveThinkingInterval,
            });
        }

        // Cooldown
        await sleep(cooldownMs);
    }

    // Cleanup
    if (noCommandCount >= MAX_NO_COMMAND) {
        await notifyGoalComplete();
        state = 'TASK_COMPLETED';
    }

    return { 
        finalState: state, 
        iterations: iterationCount, 
        goal: currentGoal 
    };
}
