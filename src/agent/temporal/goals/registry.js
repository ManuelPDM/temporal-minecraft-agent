// GoalDefinition shape:
// { id: string, description: string, type: 'llm' | 'deterministic', priority?: number }

export const GOALS = {
    SURVIVE: {
        id: 'survive',
        type: 'llm',
        description: "Survive in Minecraft. Gather resources, build shelter, find food, and protect yourself from threats.",
        priority: 1,
    },
    BUILD_BASE: {
        id: 'build_base',
        type: 'llm',
        description: "Build a shelter or base in Minecraft. Look for a good location, gather necessary materials, and construct a safe structure.",
        priority: 2,
    },
    GATHER_WOOD: {
        id: 'gather_wood',
        type: 'deterministic',
        description: "Collect 64 oak logs from nearby trees.",
        priority: 3,
    },
};
