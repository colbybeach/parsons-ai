/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { educationGuardrailSystemMessage, extractEducationResponseStyleJSON, sanitizeEducationalResponse } from '../../browser/chatThreadService.js';
import { combineChatSystemMessage } from '../../browser/convertToLLMMessageService.js';

suite('Void - Education Guardrails', () => {
	test('extractEducationResponseStyleJSON parses JSON response', () => {
		assert.strictEqual(
			extractEducationResponseStyleJSON('{"style":"concept_explain"}'),
			'concept_explain'
		);
	});

	test('extractEducationResponseStyleJSON falls back safely', () => {
		assert.strictEqual(
			extractEducationResponseStyleJSON('nonsense'),
			'guided_design'
		);
	});

	test('educationGuardrailSystemMessage includes coach restriction', () => {
		const message = educationGuardrailSystemMessage('refuse_exact_solution');
		assert.ok(message.includes('Do not provide copy-paste-ready code'));
	});

	test('sanitizeEducationalResponse removes fenced code blocks for guided design', () => {
		const sanitized = sanitizeEducationalResponse('guided_design', 'Intro\n```ts\nconst x = 1\n```\nOutro');
		assert.ok(!sanitized.includes('```'));
		assert.ok(sanitized.includes('Code example omitted'));
	});

	test('sanitizeEducationalResponse removes direct integration instructions', () => {
		const sanitized = sanitizeEducationalResponse('guided_design', 'Create a new file at client/src/components/Spinner.tsx\nPaste in something like this\nDrop anywhere in your React app.');
		assert.ok(!sanitized.includes('client/src/components/Spinner.tsx'));
		assert.ok(!sanitized.includes('Paste in something like this'));
		assert.ok(sanitized.includes('project structure'));
	});

	test('sanitizeEducationalResponse strips runnable lines for refuse exact solution', () => {
		const sanitized = sanitizeEducationalResponse('refuse_exact_solution', 'import x from "y"\nconst spinner = 1\nKeep this idea in mind.');
		assert.ok(!sanitized.includes('import x'));
		assert.ok(!sanitized.includes('const spinner'));
		assert.ok(sanitized.includes('Keep this idea in mind.'));
	});

	test('combineChatSystemMessage keeps extra guardrail when base system message is disabled', () => {
		assert.strictEqual(
			combineChatSystemMessage('base', 'extra', true),
			'extra'
		);
	});

	test('combineChatSystemMessage appends extra guardrail when base system message is enabled', () => {
		assert.strictEqual(
			combineChatSystemMessage('base', 'extra', false),
			'base\n\nextra'
		);
	});
});
