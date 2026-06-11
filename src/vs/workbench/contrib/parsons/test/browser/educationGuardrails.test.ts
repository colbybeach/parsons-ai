/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { extractLearningActivityJSON, isRepeatedQuizPrompt, isSubstantiveLearningAnswer, learningActivityStructuredOutput, learningActivitySystemMessage, quizToolFocus, shuffleMultipleChoiceActivity, tryExtractLearningActivityJSON, validateMultipleChoiceActivity } from '../../browser/chatQuizService.js';
import { agentCompletionSystemMessage, educationGuardrailSystemMessage, extractEducationResponseStyleJSON, sanitizeEducationalResponse } from '../../browser/chatResponseGuardrailService.js';
import { combineChatSystemMessage } from '../../browser/convertToLLMMessageService.js';

suite('Parsons - Education Guardrails', () => {
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

	test('extractLearningActivityJSON parses multiple-choice activity', () => {
		const activity = extractLearningActivityJSON(JSON.stringify({
			kind: 'multiple_choice',
			prompt: 'Which component structure should be used?',
			context: {
				title: 'App.tsx',
				language: 'tsx',
				code: 'function App() {\n  return <main />\n}'
			},
			options: [
				{ id: 'a', label: '<Navbar />', format: 'code' },
				{ id: 'b', label: 'Navbar()', format: 'code' },
				{ id: 'c', label: 'new Navbar()', format: 'code' }
			],
			correctOptionId: 'a',
			explanation: 'React components are rendered with JSX.'
		}));

		assert.strictEqual(activity.kind, 'multiple_choice');
		if (activity.kind !== 'multiple_choice') return;
		assert.strictEqual(activity.options.length, 3);
		assert.strictEqual(activity.correctOptionId, 'a');
		assert.strictEqual(activity.options[0].format, 'code');
		assert.strictEqual(activity.context?.language, 'tsx');
	});

	test('extractLearningActivityJSON accepts legacy short-answer shape', () => {
		const activity = extractLearningActivityJSON('{"question":"What changes?","expectedAnswer":"The component adds a loading state."}');

		assert.strictEqual(activity.kind, 'short_answer');
		assert.strictEqual(activity.prompt, 'What changes?');
	});

	test('extractLearningActivityJSON falls back when multiple-choice options are invalid', () => {
		const activity = extractLearningActivityJSON(JSON.stringify({
			kind: 'multiple_choice',
			prompt: 'What should the implementation add?',
			options: [{ id: 'a', label: 'A loading state' }],
			correctOptionId: 'missing'
		}));

		assert.strictEqual(activity.kind, 'short_answer');
		assert.ok(activity.prompt.includes('code-level consideration'));
	});

	test('extractLearningActivityJSON rejects placeholder and duplicate option labels', () => {
		const fallback = extractLearningActivityJSON('{"question":"Fallback question","expectedAnswer":"Any relevant answer."}');
		const activity = extractLearningActivityJSON(JSON.stringify({
			kind: 'multiple_choice',
			prompt: 'Which code belongs here?',
			options: [
				{ id: 'a', label: 'code', format: 'code' },
				{ id: 'b', label: 'code', format: 'code' },
				{ id: 'c', label: 'code', format: 'code' },
				{ id: 'd', label: 'code', format: 'code' }
			],
			correctOptionId: 'a'
		}), fallback);

		assert.deepStrictEqual(activity, fallback);
	});

	test('tryExtractLearningActivityJSON reports invalid generation without applying fallback', () => {
		assert.strictEqual(tryExtractLearningActivityJSON('{"kind":"multiple_choice","prompt":"Pick one","options":[{"id":"a","label":"code"},{"id":"b","label":"code"},{"id":"c","label":"code"}],"correctOptionId":"a"}'), null);
	});

	test('validateMultipleChoiceActivity grades choices locally', () => {
		const activity = extractLearningActivityJSON(JSON.stringify({
			kind: 'multiple_choice',
			prompt: 'What should the implementation add?',
			options: [
				{ id: 'a', label: 'A loading state' },
				{ id: 'b', label: 'A database table' },
				{ id: 'c', label: 'A cache entry' }
			],
			correctOptionId: 'a',
			explanation: 'The proposed edit adds a loading state.'
		}));

		assert.strictEqual(activity.kind, 'multiple_choice');
		if (activity.kind !== 'multiple_choice') return;
		assert.strictEqual(validateMultipleChoiceActivity(activity, 'a').correct, true);
		assert.strictEqual(validateMultipleChoiceActivity(activity, 'b').correct, false);
	});

	test('shuffleMultipleChoiceActivity preserves correctness with stable randomized order', () => {
		const activity = extractLearningActivityJSON(JSON.stringify({
			kind: 'multiple_choice',
			prompt: 'What should the implementation add?',
			options: [
				{ id: 'a', label: 'A loading state' },
				{ id: 'b', label: 'A database table' },
				{ id: 'c', label: 'A new route' },
				{ id: 'd', label: 'A cache' }
			],
			correctOptionId: 'a',
			explanation: 'The proposed edit adds a loading state.'
		}));

		assert.strictEqual(activity.kind, 'multiple_choice');
		if (activity.kind !== 'multiple_choice') return;
		const firstShuffle = shuffleMultipleChoiceActivity(activity, 'tool-request-123');
		const secondShuffle = shuffleMultipleChoiceActivity(activity, 'tool-request-123');
		assert.deepStrictEqual(firstShuffle.options, secondShuffle.options);
		assert.notDeepStrictEqual(firstShuffle.options, activity.options);
		assert.strictEqual(validateMultipleChoiceActivity(firstShuffle, 'a').correct, true);
	});

	test('learning activity prompt asks self-contained code implementation questions', () => {
		assert.ok(learningActivitySystemMessage.includes('HOW to implement'));
		assert.ok(learningActivitySystemMessage.includes('show the relevant code inside the activity'));
		assert.ok(learningActivitySystemMessage.includes('Avoid generic requirements questions'));
		assert.ok(learningActivitySystemMessage.includes('Never use placeholder labels'));
		assert.ok(learningActivitySystemMessage.includes('Valid multiple-choice example'));
		assert.ok(learningActivitySystemMessage.includes('Invalid output examples'));
		assert.ok(learningActivitySystemMessage.includes('CURRENT TOOL STEP'));
		assert.ok(learningActivitySystemMessage.includes('imports and renders Navbar in App.tsx'));
	});

	test('quiz tool focus separates the before and after code for an edit', () => {
		const focus = quizToolFocus({
			role: 'tool',
			type: 'tool_request',
			id: 'tool-1',
			name: 'edit_file',
			params: {
				uri: URI.file('/workspace/src/App.tsx'),
				searchReplaceBlocks: '<<<<<<< ORIGINAL\nimport React from \"react\";\n=======\nimport React from \"react\";\nimport Navbar from \"./Navbar\";\n>>>>>>> UPDATED'
			},
			content: '',
			result: null,
			rawParams: {},
			mcpServerName: undefined,
		});

		assert.strictEqual(focus.fileName, 'App.tsx');
		assert.ok(focus.details.includes('code being replaced'));
		assert.ok(focus.details.includes('import Navbar'));
	});

	test('repeated quiz prompts detect exact and lightly rephrased questions', () => {
		const prior = ['Which JSX correctly renders the Navbar component inside App?'];
		assert.strictEqual(isRepeatedQuizPrompt('Which JSX correctly renders the Navbar component inside App?', prior), true);
		assert.strictEqual(isRepeatedQuizPrompt('What state controls whether the mobile menu is open?', prior), false);
	});

	test('learning activity structured output requires the complete response envelope', () => {
		assert.strictEqual(learningActivityStructuredOutput.name, 'learning_activity');
		assert.strictEqual(learningActivityStructuredOutput.strict, true);
		assert.deepStrictEqual(learningActivityStructuredOutput.schema.required, [
			'kind',
			'prompt',
			'context',
			'options',
			'correctOptionId',
			'explanation',
			'expectedAnswer'
		]);
	});

	test('agent completion prompt distinguishes completed work from implementation guidance', () => {
		assert.ok(agentCompletionSystemMessage.includes('tool has just completed successfully'));
		assert.ok(agentCompletionSystemMessage.includes('Done.'));
		assert.ok(agentCompletionSystemMessage.includes('Do not provide pseudocode'));
	});

	test('isSubstantiveLearningAnswer accepts brief explanations but rejects filler', () => {
		assert.strictEqual(isSubstantiveLearningAnswer('Use state for the open menu.'), true);
		assert.strictEqual(isSubstantiveLearningAnswer('render the links with map'), true);
		assert.strictEqual(isSubstantiveLearningAnswer('idk'), false);
		assert.strictEqual(isSubstantiveLearningAnswer('whatever'), false);
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
