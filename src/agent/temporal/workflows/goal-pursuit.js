import {
    defineSignal,
    defineQuery,
    setHandler,
    condition,
    sleep,
    continueAsNew,
    proxyActivities,
} from '@temporalio/workflow';

const { executeLLMGoalIteration, executePassiveThinking } = proxyActivities({
    startToCloseTimeout: '5 minutes',
    heartbeatTimeout: '60 seconds',
    retry: {
        maximumAttempts: 3,
        backoffCoefficient: 1,
    },
});

export const interruptSignal = defineSignal('interrupt');
export const pauseSignal = defineSignal('pause');
export const resumeSignal = defineSignal('resume');
export const updateGoalSignal = defineSignal('updateGoal');

export const getGoalStateQuery = defineQuery('getState');

// Durable replacement for SelfPrompter.startLoop().
// Each LLM call is a tracked activity. Stops after MAX_NO_COMMAND consecutive
// responses that contain no command. Uses continueAsNew every 200 iterations
// to keep Temporal history from growing unbounded.
export async function GoalPursuitWorkflow(input) {
    const {
        goal,
        agentName,
        iterationCount: startIteration = 0,
        noCommandCount: startNoCommand = 0,
        cooldownMs = 2000,
        passiveThinkingInterval = 10,
    } = input;

    const MAX_NO_COMMAND = 3;

    let currentGoal = goal;
    let iterationCount = startIteration;
    let noCommandCount = startNoCommand;
    let paused = false;
    let interrupted = false;
    let lastUsedCommand = false;
    let lastCommand = null;
    let passiveThinkingCounter = 0;

    setHandler(interruptSignal, () => { interrupted = true; });
    setHandler(pauseSignal, () => { paused = true; });
    setHandler(resumeSignal, () => { paused = false; });
    setHandler(updateGoalSignal, (newGoal) => { currentGoal = newGoal; });

    setHandler(getGoalStateQuery, () => ({
        state: interrupted ? 'INTERRUPTED' : paused ? 'PAUSED' : 'RUNNING',
        goal: currentGoal,
        agentName,
        iterationCount,
        noCommandCount,
        lastUsedCommand,
        lastCommand,
    }));

    while (!interrupted && noCommandCount < MAX_NO_COMMAND) {
        // Wait out any pause
        if (paused) {
            await condition(() => !paused || interrupted, '365 days');
            if (interrupted) break;
        }

        // Execute one LLM iteration (the activity handles the actual handleMessage call)
        const result = await executeLLMGoalIteration(currentGoal.description);
        lastUsedCommand = result.used_command;
        if (result.command) lastCommand = result.command;
        iterationCount++;

        if (result.used_command) {
            noCommandCount = 0;
        } else {
            noCommandCount++;
        }

        // Passive thinking: run every N iterations to consolidate memory
        if (passiveThinkingInterval > 0) {
            passiveThinkingCounter++;
            if (passiveThinkingCounter >= passiveThinkingInterval) {
                passiveThinkingCounter = 0;
                await executePassiveThinking();
            }
        }

        // continueAsNew every 200 iterations to keep history manageable
        if (iterationCount >= 200 && !interrupted && noCommandCount < MAX_NO_COMMAND) {
            await continueAsNew({
                goal: currentGoal,
                agentName,
                iterationCount,
                noCommandCount: 0,
                cooldownMs,
                passiveThinkingInterval,
            });
        }

        // Cooldown between iterations
        if (!interrupted && noCommandCount < MAX_NO_COMMAND) {
            await sleep(cooldownMs);
        }
    }
}
