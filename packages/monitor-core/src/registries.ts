import type {
	CliApi,
	CliCommandSpec,
	DashboardApi,
	DashboardPage,
	DashboardWidget,
	HealthState,
	MenuApi,
	MenuModel,
	MenuSection,
} from '@pieces-dev/monitor-sdk';

/** Collects menu-section providers and assembles the JSON menu model. */
export class MenuRegistry {
	private readonly providers: Array<() => MenuSection> = [];

	constructor(private readonly now: () => number = Date.now) {}

	api(): MenuApi {
		return { contribute: (provider) => this.providers.push(provider) };
	}

	build(status: HealthState): MenuModel {
		return { status, sections: this.providers.map((p) => p()), at: this.now() };
	}
}

/** Collects dashboard widgets and pages contributed by extensions. */
export class DashboardRegistry {
	readonly widgets: DashboardWidget[] = [];
	readonly pages: DashboardPage[] = [];

	forExtension(): DashboardApi {
		return {
			widget: (widget) => this.widgets.push(widget),
			page: (page) => this.pages.push(page),
		};
	}
}

/** Collects CLI subcommands grafted onto `pmon` by extensions. */
export class CliRegistry {
	readonly specs: CliCommandSpec[] = [];

	forExtension(): CliApi {
		return { command: (spec) => this.specs.push(spec) };
	}
}
