import { createAgentStateActivities } from './agent-state.js';
import { createGoalExecutionActivities } from './goal-execution.js';
import { createMineflayerSkillActivities } from './mineflayer-skills.js';

// Factory: returns a flat activities object closed over `agent`.
// Pass the result directly to Worker.create({ activities }).
export function createActivities(agent) {
    return {
        ...createAgentStateActivities(agent),
        ...createGoalExecutionActivities(agent),
        ...createMineflayerSkillActivities(agent),
    };
}
