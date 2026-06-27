import type { Command, CommandApi } from '@pieces-dev/monitor-sdk';

/**
 * The command registry: one named verb invokable identically from menu bar,
 * dashboard, CLI, and API. Extensions register; core dispatches.
 */
export class Commands {
	private readonly commands = new Map<string, Command>();

	api(): CommandApi {
		return {
			register: (command) => {
				this.commands.set(command.id, command);
			},
		};
	}

	get(id: string): Command | undefined {
		return this.commands.get(id);
	}

	list(): Command[] {
		return [...this.commands.values()];
	}

	async dispatch(id: string, params?: Record<string, unknown>): Promise<unknown> {
		const command = this.commands.get(id);
		if (!command) throw new Error(`unknown command: ${id}`);
		return command.handler(params);
	}
}
