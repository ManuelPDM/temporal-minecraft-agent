import { heartbeat } from '@temporalio/activity';
import { executeCommand } from '../../commands/index.js';

export function createGoalExecutionActivities(agent) {
    return {
        // Mirror of SelfPrompter.startLoop()'s inner body — one iteration per call.
        // Returns { used_command, command, llm_response } for Temporal UI visibility.
        async executeLLMGoalIteration(goalDescription) {
            // Wait until the agent has fully spawned before executing.
            // This guards against stale activities from previous sessions retrying
            // on the new worker before agent.start() has finished.
            let waitedMs = 0;
            while (!agent.bot || !agent.bot.entity) {
                if (waitedMs >= 90_000) throw new Error('Agent did not spawn within 90s — aborting activity');
                heartbeat({ phase: 'waiting_for_spawn', waitedMs });
                await new Promise(r => setTimeout(r, 1_000));
                waitedMs += 1_000;
            }

            const heartbeatInterval = setInterval(() => {
                const current = agent._currentCommand || null;
                heartbeat(current
                    ? { phase: 'executing', command: current }
                    : { phase: 'waiting_for_llm', goal: goalDescription }
                );
            }, 10_000);
            try {
                const msg =
                    `You are self-prompting with the goal: '${goalDescription}'. ` +
                    `Your next response MUST contain a command with this syntax: !commandName. Respond:`;
                // max_responses=1, execute_commands=false
                const command = await agent.handleMessage('system', msg, 1, false);
                return { used_command: !!command, command: typeof command === 'string' ? command : null };
            } finally {
                clearInterval(heartbeatInterval);
            }
        },

        async executeActionActivity(command) {
            const heartbeatInterval = setInterval(() => heartbeat(`Executing ${command}`), 10_000);
            try {
                agent._currentCommand = command;
                let execute_res = await executeCommand(agent, command);
                agent._currentCommand = null;
                agent._lastExecutedCommand = command;

                if (execute_res) {
                    agent.history.add('system', execute_res);
                    agent.history.save();
                }
                return execute_res || "Action complete.";
            } catch (err) {
                agent._currentCommand = null;
                console.error('[Temporal] Action execution failed:', err);
                const errorMsg = `Command failed: ${err.message}`;
                agent.history.add('system', errorMsg);
                agent.history.save();
                return errorMsg;
            } finally {
                clearInterval(heartbeatInterval);
            }
        },


        // Called when GoalPursuit exits naturally (3 no-command responses).
        // Resets the self_prompter so it doesn't linger in a zombie loop_active=true state.
        async notifyGoalComplete() {
            agent.self_prompter.onGoalPursuitEnded();
            return {};
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
