import {
    defineSignal,
    defineQuery,
    setHandler,
    condition,
    continueAsNew,
    startChild,
    getExternalWorkflowHandle,
    workflowInfo,
} from '@temporalio/workflow';

// --- Signal definitions (exported so callers can reference them by name) ---
export const agentConnectedSignal = defineSignal('agentConnected');
export const agentSpawnedSignal = defineSignal('agentSpawned');
export const agentDisconnectedSignal = defineSignal('agentDisconnected');
export const shutdownSignal = defineSignal('shutdown');
export const startGoalPursuitSignal = defineSignal('startGoalPursuit');
export const stopGoalPursuitSignal = defineSignal('stopGoalPursuit');
export const pauseGoalPursuitSignal = defineSignal('pauseGoalPursuit');
export const resumeGoalPursuitSignal = defineSignal('resumeGoalPursuit');
export const taskCompletedSignal = defineSignal('taskCompleted');

// --- Query definitions ---
export const getStatusQuery = defineQuery('getStatus');

// State machine: BOOTING → CONNECTING → RUNNING → DONE
// Uses continueAsNew every ~500 events to keep workflow history manageable.
export async function AgentLifecycleWorkflow(params) {
    const {
        agentName,
        sessionCount = 0,
        currentGoalId = null,
        goalWorkflowId = null,
    } = params;

    const info = workflowInfo();
    const taskQueue = info.taskQueue;

    let state = 'BOOTING';
    let eventCount = 0;
    let activeGoalId = currentGoalId;
    let activeGoalWorkflowId = goalWorkflowId;

    // Pending intent flags — set synchronously in signal handlers,
    // acted on in the main event loop (which can safely await Temporal APIs).
    let pendingGoalStart = null;
    let pendingGoalStop = false;
    let pendingGoalPause = false;
    let pendingGoalResume = false;
    let shutdownRequested = false;

    // ---- Query handler ----
    setHandler(getStatusQuery, () => ({
        state,
        agentName,
        sessionCount,
        currentGoalId: activeGoalId,
        goalWorkflowId: activeGoalWorkflowId,
    }));

    // ---- Signal handlers (synchronous — just set flags) ----
    setHandler(agentConnectedSignal, () => {
        eventCount++;
        state = 'CONNECTING';
    });

    setHandler(agentSpawnedSignal, () => {
        eventCount++;
        state = 'RUNNING';
    });

    setHandler(agentDisconnectedSignal, () => {
        eventCount++;
        state = 'DONE';
        shutdownRequested = true;
    });

    setHandler(taskCompletedSignal, (_data) => {
        eventCount++;
        state = 'DONE';
        shutdownRequested = true;
    });

    setHandler(shutdownSignal, () => {
        eventCount++;
        state = 'DONE';
        shutdownRequested = true;
    });

    setHandler(startGoalPursuitSignal, ({ goalId, description, type = 'llm' }) => {
        eventCount++;
        activeGoalId = goalId;
        pendingGoalStart = { goalId, description, type };
    });

    setHandler(stopGoalPursuitSignal, () => {
        eventCount++;
        pendingGoalStop = true;
    });

    setHandler(pauseGoalPursuitSignal, () => {
        eventCount++;
        pendingGoalPause = true;
    });

    setHandler(resumeGoalPursuitSignal, () => {
        eventCount++;
        pendingGoalResume = true;
    });

    // ---- Main event loop ----
    while (true) {
        // Block until something needs processing
        await condition(
            () =>
                shutdownRequested ||
                pendingGoalStart !== null ||
                pendingGoalStop ||
                pendingGoalPause ||
                pendingGoalResume ||
                eventCount >= 500,
            '365 days',
        );

        // Start a new GoalPursuitWorkflow child
        if (pendingGoalStart) {
            const { goalId, description, type } = pendingGoalStart;
            pendingGoalStart = null;

            // Cancel any previously running goal child first
            if (activeGoalWorkflowId) {
                try {
                    await getExternalWorkflowHandle(activeGoalWorkflowId).signal('interrupt');
                } catch (_) {}
            }

            const goalWfId = `goal-pursuit-${agentName}-${goalId}-${Date.now()}`;
            await startChild('GoalPursuitWorkflow', {
                workflowId: goalWfId,
                taskQueue,
                args: [{
                    goal: { id: goalId, description, type },
                    agentName,
                    iterationCount: 0,
                    noCommandCount: 0,
                    cooldownMs: 2000,
                    passiveThinkingInterval: 10,
                }],
            });
            activeGoalWorkflowId = goalWfId;
        }

        // Stop (interrupt) the active goal child
        if (pendingGoalStop && activeGoalWorkflowId) {
            pendingGoalStop = false;
            try {
                await getExternalWorkflowHandle(activeGoalWorkflowId).signal('interrupt');
            } catch (_) {}
            activeGoalWorkflowId = null;
        } else {
            pendingGoalStop = false;
        }

        // Pause the active goal child
        if (pendingGoalPause && activeGoalWorkflowId) {
            pendingGoalPause = false;
            try {
                await getExternalWorkflowHandle(activeGoalWorkflowId).signal('pause');
            } catch (_) {}
        } else {
            pendingGoalPause = false;
        }

        // Resume the active goal child
        if (pendingGoalResume && activeGoalWorkflowId) {
            pendingGoalResume = false;
            try {
                await getExternalWorkflowHandle(activeGoalWorkflowId).signal('resume');
            } catch (_) {}
        } else {
            pendingGoalResume = false;
        }

        // Shutdown: interrupt goal child and exit
        if (shutdownRequested) {
            if (activeGoalWorkflowId) {
                try {
                    await getExternalWorkflowHandle(activeGoalWorkflowId).signal('interrupt');
                } catch (_) {}
            }
            return;
        }

        // Event limit reached — continue as new to keep history manageable
        if (eventCount >= 500) {
            await continueAsNew({
                agentName,
                sessionCount: sessionCount + 1,
                currentGoalId: activeGoalId,
                goalWorkflowId: activeGoalWorkflowId,
            });
        }
    }
}
