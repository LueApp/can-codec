import damiao from '../../../configs/example_damiao.yaml?raw';

export interface ConfigTemplate {
	id: string;
	name: string;
	description: string;
	filename: string;
	content: string;
}

export const CONFIG_TEMPLATES: ConfigTemplate[] = [
	{
		id: 'damiao',
		name: 'Damiao Motor',
		description: 'V1.4 MIT-style CAN control (7 motors)',
		filename: 'example_damiao.yaml',
		content: damiao,
	},
];
