import { heartbeat } from '@temporalio/activity';

export function createGoalExecutionActivities(agent) {
    return {
        // Mirror of SelfPrompter.startLoop()'s inner body — one iteration per call.
        // Returns { used_command: boolean }.
        async executeLLMGoalIteration(goalDescription) {
            const heartbeatInterval = setInterval(() => heartbeat('LLM iteration in progress'), 30_000);
            try {
                const msg =
                    `You are self-prompting with the goal: '${goalDescription}'. ` +
                    `Your next response MUST contain a command with this syntax: !commandName. Respond:`;
                const used_command = await agent.handleMessage('system', msg, -1);
                return { used_command: !!used_command };
            } finally {
                clearInterval(heartbeatInterval);
            }
        },

        // Runs agent.handlePassiveThinking() — consolidates memory between LLM iterations.
        // Returns { memoryUpdated: boolean }.
        async executePassiveThinking() {
            const heartbeatInterval = setInterval(() => heartbeat('Passive thinking in progress'), 15_000);
            try {
                await agent.handlePassiveThinking();
                return { memoryUpdated: true };
            } catch (err) {
                console.warn('[Temporal] executePassiveThinking failed:', err.message);
                return { memoryUpdated: false };
            } finally {
                clearInterval(heartbeatInterval);
            }
        },
    };
}
