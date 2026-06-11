/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License v2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { truncate } from '../../../../base/common/strings.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { LearningActivity, LearningActivityResponse, LearningAnswerValidationResult } from '../common/chatQuizTypes.js';
import { ToolMessage } from '../common/chatThreadServiceTypes.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { BuiltinToolCallParams, ToolName } from '../common/toolsServiceTypes.js';
import { extractSearchReplaceBlocks } from '../common/helpers/extractCodeFromResult.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';

type PendingToolMessage = ToolMessage<ToolName> & { type: 'tool_request' }

export type ChatQuizContext = {
	threadId: string;
	toolMessage: PendingToolMessage;
	userRequest: string;
	assistantSummary: string;
}

export interface IChatQuizService {
	readonly _serviceBrand: undefined;
	generateActivity(context: ChatQuizContext): Promise<LearningActivity>;
	validateAnswer(context: ChatQuizContext & { response: LearningActivityResponse }): Promise<LearningAnswerValidationResult>;
}

export const IChatQuizService = createDecorator<IChatQuizService>('voidChatQuizService');

export type QuizToolFocus = {
	fileName: string;
	operation: string;
	details: string;
}

export const quizToolFocus = (toolMessage: PendingToolMessage): QuizToolFocus => {
	if (toolMessage.name === 'edit_file') {
		const params = toolMessage.params as BuiltinToolCallParams['edit_file']
		const blocks = extractSearchReplaceBlocks(params.searchReplaceBlocks)
		const details = blocks.length > 0
			? blocks.slice(0, 4).map((block, index) => [
				`Edit ${index + 1} - code being replaced:`,
				truncate(block.orig || '(insertion)', 900),
				`Edit ${index + 1} - code being added:`,
				truncate(block.final || '(deletion)', 900),
			].join('\n')).join('\n\n')
			: truncate(params.searchReplaceBlocks, 1800)
		return {
			fileName: params.uri.path.split('/').pop() || params.uri.path,
			operation: blocks.every(block => !block.orig.trim())
				? 'insert code into an existing file'
				: blocks.every(block => !block.final.trim())
					? 'remove code from an existing file'
					: 'replace specific code in an existing file',
			details,
		}
	}
	if (toolMessage.name === 'rewrite_file') {
		const params = toolMessage.params as BuiltinToolCallParams['rewrite_file']
		return {
			fileName: params.uri.path.split('/').pop() || params.uri.path,
			operation: 'replace the complete file contents',
			details: `New file contents:\n${truncate(params.newContent, 2400)}`,
		}
	}
	if (toolMessage.name === 'create_file_or_folder') {
		const params = toolMessage.params as BuiltinToolCallParams['create_file_or_folder']
		return {
			fileName: params.uri.path.split('/').pop() || params.uri.path,
			operation: params.isFolder ? 'create a folder' : 'create an empty file',
			details: `Target path: ${params.uri.path}`,
		}
	}
	if (toolMessage.name === 'delete_file_or_folder') {
		const params = toolMessage.params as BuiltinToolCallParams['delete_file_or_folder']
		return {
			fileName: params.uri.path.split('/').pop() || params.uri.path,
			operation: params.isFolder ? 'delete a folder' : 'delete a file',
			details: `Target path: ${params.uri.path}`,
		}
	}
	return {
		fileName: toolMessage.name,
		operation: `run ${toolMessage.name}`,
		details: truncate(JSON.stringify(toolMessage.params, null, 2), 1800),
	}
}

const normalizedPromptWords = (prompt: string): Set<string> => new Set(
	prompt.toLowerCase().match(/[a-z0-9_]+/g)?.filter(word => word.length > 2 && !['which', 'what', 'should', 'code', 'this', 'that', 'with', 'from', 'into'].includes(word)) ?? []
)

export const isRepeatedQuizPrompt = (prompt: string, priorPrompts: string[]): boolean => {
	const normalized = prompt.trim().toLowerCase().replace(/\s+/g, ' ')
	const words = normalizedPromptWords(prompt)
	return priorPrompts.some(priorPrompt => {
		const priorNormalized = priorPrompt.trim().toLowerCase().replace(/\s+/g, ' ')
		if (normalized === priorNormalized) return true
		const priorWords = normalizedPromptWords(priorPrompt)
		if (words.size === 0 || priorWords.size === 0) return false
		const overlap = [...words].filter(word => priorWords.has(word)).length
		return overlap / Math.min(words.size, priorWords.size) >= 0.8
	})
}

export const fallbackLearningActivity = (toolMessage?: PendingToolMessage): LearningActivity => {
	if (toolMessage?.name === 'rewrite_file') {
		const params = toolMessage.params as BuiltinToolCallParams['rewrite_file']
		return {
			version: 1,
			kind: 'short_answer',
			prompt: 'Looking at this file content, describe one implementation detail you recognize or would verify before replacing the file.',
			context: {
				title: params.uri.path.split('/').pop() || 'File content',
				code: truncate(params.newContent, 1800)
			},
			expectedAnswer: 'Accept any reasonable observation about the shown code, including its component structure, data flow, event handling, styling, imports, accessibility, or behavior.'
		}
	}
	if (toolMessage?.name === 'edit_file') {
		const params = toolMessage.params as BuiltinToolCallParams['edit_file']
		return {
			version: 1,
			kind: 'short_answer',
			prompt: 'Looking at this edit block, describe what code pattern or implementation step it appears to involve.',
			context: {
				title: params.uri.path.split('/').pop() || 'Edit block',
				code: truncate(params.searchReplaceBlocks, 1800)
			},
			expectedAnswer: 'Accept any plausible description grounded in the shown edit block, even if it is brief, incomplete, or uses informal terminology.'
		}
	}
	return {
		version: 1,
		kind: 'short_answer',
		prompt: `What code-level consideration would you check before running ${toolMessage?.name || 'this implementation step'}?`,
		expectedAnswer: 'Accept any plausible and relevant implementation consideration. The learner does not need to identify one exact answer.'
	}
}

export const tryExtractLearningActivityJSON = (fullText: string): LearningActivity | null => {
	const trimmed = fullText.trim()
	const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
	const jsonMatch = withoutFence.match(/\{[\s\S]*\}/)
	const jsonStr = jsonMatch ? jsonMatch[0] : withoutFence

	try {
		const parsed = JSON.parse(jsonStr) as {
			kind?: unknown;
			prompt?: unknown;
			question?: unknown;
			context?: unknown;
			options?: unknown;
			correctOptionId?: unknown;
			explanation?: unknown;
			expectedAnswer?: unknown;
		}
		const prompt = typeof parsed.prompt === 'string' && parsed.prompt.trim()
			? parsed.prompt.trim()
			: typeof parsed.question === 'string' && parsed.question.trim()
				? parsed.question.trim()
				: null
		const rawContext = parsed.context && typeof parsed.context === 'object'
			? parsed.context as { title?: unknown; language?: unknown; code?: unknown }
			: null
		const context = rawContext && typeof rawContext.code === 'string' && rawContext.code.trim()
			? {
				code: rawContext.code.trim(),
				...(typeof rawContext.title === 'string' && rawContext.title.trim() ? { title: rawContext.title.trim() } : {}),
				...(typeof rawContext.language === 'string' && rawContext.language.trim() ? { language: rawContext.language.trim() } : {}),
			}
			: undefined

		if (parsed.kind === 'multiple_choice' && prompt && Array.isArray(parsed.options)) {
			const options = parsed.options.flatMap((option) => {
				if (!option || typeof option !== 'object') return []
				const { id, label, format } = option as { id?: unknown; label?: unknown; format?: unknown }
				if (typeof id !== 'string' || !id.trim() || typeof label !== 'string' || !label.trim()) return []
				return [{ id: id.trim(), label: label.trim(), format: format === 'code' ? 'code' as const : 'text' as const }]
			})
			const optionIds = new Set(options.map(option => option.id))
			const normalizedLabels = options.map(option => option.label.trim().toLowerCase())
			const optionLabels = new Set(normalizedLabels)
			const hasPlaceholderLabel = normalizedLabels.some(label => /^(code|text|option|answer|snippet|choice)(\s+[a-d1-4])?[.!:]?$/i.test(label))
			const correctOptionId = typeof parsed.correctOptionId === 'string' ? parsed.correctOptionId.trim() : ''
			if (
				(options.length === 3 || options.length === 4)
				&& optionIds.size === options.length
				&& optionLabels.size === options.length
				&& !hasPlaceholderLabel
				&& optionIds.has(correctOptionId)
			) {
				return {
					version: 1,
					kind: 'multiple_choice',
					prompt,
					...(context ? { context } : {}),
					options,
					correctOptionId,
					explanation: typeof parsed.explanation === 'string' && parsed.explanation.trim()
						? parsed.explanation.trim()
						: 'That choice best matches the intended behavior from the request.'
				}
			}
		}

		if (prompt && typeof parsed.expectedAnswer === 'string' && parsed.expectedAnswer.trim()) {
			return {
				version: 1,
				kind: 'short_answer',
				prompt,
				...(context ? { context } : {}),
				expectedAnswer: parsed.expectedAnswer.trim()
			}
		}
	}
	catch {
		return null
	}
	return null
}

export const extractLearningActivityJSON = (fullText: string, fallback = fallbackLearningActivity()): LearningActivity =>
	tryExtractLearningActivityJSON(fullText) ?? fallback

export const isSubstantiveLearningAnswer = (answer: string): boolean => {
	const normalized = answer.trim().toLowerCase()
	if (normalized.length < 6) return false
	if (/^(idk|i don't know|dont know|no idea|skip|whatever|nothing|n\/a)[.!]?$/i.test(normalized)) return false
	return /[a-z]{3}/i.test(normalized)
}

export const validateMultipleChoiceActivity = (
	activity: LearningActivity & { kind: 'multiple_choice' },
	optionId: string
): LearningAnswerValidationResult => optionId === activity.correctOptionId
	? { correct: true, feedback: activity.explanation }
	: { correct: false, feedback: 'Not quite. Revisit which code pattern correctly implements this step.' }

export const shuffleMultipleChoiceActivity = (
	activity: LearningActivity & { kind: 'multiple_choice' },
	seed: string
): LearningActivity & { kind: 'multiple_choice' } => {
	let state = 2166136261
	for (let i = 0; i < seed.length; i += 1) {
		state ^= seed.charCodeAt(i)
		state = Math.imul(state, 16777619)
	}
	const options = [...activity.options]
	for (let i = options.length - 1; i > 0; i -= 1) {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		const swapIdx = (state >>> 0) % (i + 1)
		;[options[i], options[swapIdx]] = [options[swapIdx], options[i]]
	}
	return { ...activity, options }
}

export const learningActivitySystemMessage = [
	'You are generating a learning activity for a student before a code edit is applied.',
	'Create a self-contained question about HOW to implement the requested feature in code.',
	'The student cannot see the pending code edit, but you may and should show the relevant code inside the activity itself.',
	'Use hidden implementation details to construct visible, answerable snippets. Never refer to code that you do not include in the prompt, context, or options.',
	'Strong activity types include:',
	'- choose which code snippet should be written;',
	'- identify what a shown line or small block does;',
	'- choose the correct component structure, state update, event handler, data flow, API usage, or accessibility pattern;',
	'- predict the effect of a shown snippet;',
	'- fill in or describe a small missing implementation step.',
	'Avoid generic requirements questions such as what the user should see, what feature they requested, or what outcome they want. The user already supplied that information.',
	'Avoid asking why an unseen proposed edit was made or what unseen code does.',
	'Prefer multiple choice with concrete code snippets. Use short answer only when it produces a better code-level learning check.',
	'Return one JSON object only. Do not use Markdown fences, commentary, schema annotations, or placeholder values.',
	'For multiple choice, return only JSON in this exact shape: {"kind":"multiple_choice","prompt":string,"context":{"title":string,"language":string,"code":string},"options":[{"id":string,"label":string,"format":"text"|"code"}],"correctOptionId":string,"explanation":string}.',
	'context is optional, but include it when the learner needs surrounding code to answer. Keep it focused, usually 3-12 lines.',
	'The option label must contain the actual answer text or code snippet. Never use placeholder labels such as "code", "text", "snippet", or "option".',
	'Use option format "code" when the label itself is an actual code snippet. Code options may contain newlines.',
	'Provide exactly 3 or 4 concise options with unique ids. Include one clearly best answer and plausible code-level distractors.',
	'For short answer, return only JSON in this exact shape: {"kind":"short_answer","prompt":string,"context":{"title":string,"language":string,"code":string},"expectedAnswer":string}.',
	'prompt: one concise, specific implementation question that can be answered using the code shown in the activity.',
	'expectedAnswer: short rubric answer (1-3 sentences) that would count as correct.',
	'Valid multiple-choice example:',
	'{"kind":"multiple_choice","prompt":"Which JSX should replace the missing return value?","context":{"title":"Navbar.tsx","language":"tsx","code":"const Navbar = () => {\\n  return (\\n    // What goes here?\\n  );\\n};"},"options":[{"id":"nav","label":"<nav aria-label=\\"Main navigation\\"><a href=\\"/\\">Home</a></nav>","format":"code"},{"id":"call","label":"Navbar()","format":"code"},{"id":"ctor","label":"new Navbar()","format":"code"}],"correctOptionId":"nav","explanation":"A React component should return JSX, and nav gives the links appropriate semantics."}',
	'Valid short-answer example:',
	'{"kind":"short_answer","prompt":"What state would you add to control whether the mobile menu is visible?","context":{"title":"Navbar.tsx","language":"tsx","code":"const Navbar = () => {\\n  // Add menu state here\\n};"},"expectedAnswer":"A boolean state value such as isMenuOpen, with a setter used by the menu button."}',
	'Invalid output examples: labels that only say "code"; duplicate option labels; fewer than 3 options; a correctOptionId not present in options; prose outside the JSON object.',
	'Before responding, verify that every option label contains the actual answer, all option ids and labels are unique, and correctOptionId matches exactly one option.',
	'Write the activity in natural language for the student.',
	'Do not mention tool calls, function-call machinery, AI behavior, raw params, or internal implementation metadata.',
	'The correct answer must be inferable from the user request plus the code and context included in the activity itself.',
	'The CURRENT TOOL STEP is the primary subject. The original user request is background only.',
	'Ask about the exact local code operation being proposed in the target file, not another part of the broader feature.',
	'For example, if the current edit imports and renders Navbar in App.tsx, ask about importing, rendering, component composition, or the shown App.tsx change. Do not ask what links or text Navbar itself contains.',
	'Do not repeat or lightly rephrase a prior question listed in the request. Choose a different code concept grounded in the current step.'
].join('\n')

export const learningActivityStructuredOutput = {
	name: 'learning_activity',
	description: 'A self-contained code implementation learning activity.',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			kind: { type: 'string', enum: ['multiple_choice', 'short_answer'] },
			prompt: { type: 'string' },
			context: {
				anyOf: [{
					type: 'object',
					additionalProperties: false,
					properties: {
						title: { type: 'string' },
						language: { type: 'string' },
						code: { type: 'string' },
					},
					required: ['title', 'language', 'code'],
				}, { type: 'null' }],
			},
			options: {
				type: 'array',
				minItems: 0,
				maxItems: 4,
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						id: { type: 'string' },
						label: { type: 'string' },
						format: { type: 'string', enum: ['text', 'code'] },
					},
					required: ['id', 'label', 'format'],
				},
			},
			correctOptionId: { type: 'string' },
			explanation: { type: 'string' },
			expectedAnswer: { type: 'string' },
		},
		required: ['kind', 'prompt', 'context', 'options', 'correctOptionId', 'explanation', 'expectedAnswer'],
	},
} as const

class ChatQuizService implements IChatQuizService {
	readonly _serviceBrand: undefined;
	private readonly activityByToolId: Record<string, LearningActivity | undefined> = {}
	private readonly promptsByThreadId: Record<string, string[] | undefined> = {}

	constructor(
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IVoidSettingsService private readonly settingsService: IVoidSettingsService,
		@IConvertToLLMMessageService private readonly convertToLLMMessagesService: IConvertToLLMMessageService,
	) { }

	private currentModelSelectionProps() {
		const modelSelection = this.settingsService.state.modelSelectionOfFeature.Chat
		const modelSelectionOptions = modelSelection
			? this.settingsService.state.optionsOfModelSelection.Chat[modelSelection.providerName]?.[modelSelection.modelName]
			: undefined
		return { modelSelection, modelSelectionOptions }
	}

	generateActivity(context: ChatQuizContext): Promise<LearningActivity> {
		const { toolMessage } = context
		const fallback = fallbackLearningActivity(toolMessage)
		const cached = this.activityByToolId[toolMessage.id]
		if (cached) return Promise.resolve(cached)
		const focus = quizToolFocus(toolMessage)
		const priorPrompts = this.promptsByThreadId[context.threadId] ?? []
		const prompt = [
			'CURRENT TOOL STEP - this is the required subject of the question:',
			`Target file: ${focus.fileName}`,
			`Local operation: ${focus.operation}`,
			focus.details,
			'',
			'Broader user request - background only:',
			context.userRequest || '(No user request was available.)',
			'',
			'Assistant summary - background only:',
			context.assistantSummary || '(No assistant explanation was available.)',
			'',
			'Questions already asked in this thread - do not repeat or lightly rephrase:',
			priorPrompts.length > 0 ? priorPrompts.slice(-6).map(item => `- ${item}`).join('\n') : '(none)',
			'',
			'Generate one code-level learning activity specifically about the CURRENT TOOL STEP.',
			'If the question references code, include enough exact surrounding code in context or options to answer it.',
			'Do not ask about feature details that are not changed by this tool call.'
		].join('\n')

		return new Promise(resolve => {
			const { modelSelection, modelSelectionOptions } = this.currentModelSelectionProps()
			let settled = false
			const finish = (activity: LearningActivity) => {
				if (settled) return
				settled = true
				this.activityByToolId[toolMessage.id] = activity
				this.promptsByThreadId[context.threadId] = [...(this.promptsByThreadId[context.threadId] ?? []), activity.prompt].slice(-12)
				resolve(activity)
			}
			const sendAttempt = (attempt: number, rejectedOutput?: string) => {
				if (settled) return
				let handled = false
				const retryOrFinish = (failureOutput: string) => {
					if (handled || settled) return
					handled = true
					if (attempt === 0) sendAttempt(1, failureOutput)
					else finish(fallback)
				}
				const attemptPrompt = rejectedOutput
					? `${prompt}\n\nYour previous output failed the required activity contract:\n${truncate(rejectedOutput, 3000)}\n\nCorrect it now. Return a fresh JSON object only. Use a short-answer activity if you cannot produce three meaningful, distinct multiple-choice options.`
					: prompt
				const { messages, separateSystemMessage } = this.convertToLLMMessagesService.prepareLLMSimpleMessages({
					simpleMessages: [{ role: 'user', content: attemptPrompt }],
					systemMessage: learningActivitySystemMessage,
					modelSelection,
					featureName: 'Chat',
				})
				const requestId = this.llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					messages,
					separateSystemMessage,
					chatMode: null,
					structuredOutput: learningActivityStructuredOutput,
					modelSelection,
					modelSelectionOptions,
					overridesOfModel: this.settingsService.state.overridesOfModel,
					onText: () => { },
					onFinalMessage: ({ fullText }) => {
						if (handled || settled) return
						const activity = tryExtractLearningActivityJSON(fullText)
						if (!activity) return retryOrFinish(fullText)
						if (isRepeatedQuizPrompt(activity.prompt, priorPrompts)) {
							return retryOrFinish(`The generated prompt repeated an earlier question: ${activity.prompt}`)
						}
						handled = true
						finish(activity.kind === 'multiple_choice' ? shuffleMultipleChoiceActivity(activity, toolMessage.id) : activity)
					},
					onError: () => retryOrFinish('(The generation request failed before returning output.)'),
					onAbort: () => { handled = true; finish(fallback) },
					logging: { loggingName: 'Chat - Generate Learning Activity', loggingExtras: { threadId: context.threadId, toolName: toolMessage.name, attempt: attempt + 1 } },
				})
				if (!requestId) retryOrFinish('(The generation request could not be started.)')
			}
			sendAttempt(0)
		})
	}

	validateAnswer(context: ChatQuizContext & { response: LearningActivityResponse }): Promise<LearningAnswerValidationResult> {
		const { toolMessage, response } = context
		const activity = this.activityByToolId[toolMessage.id] ?? fallbackLearningActivity(toolMessage)
		if (activity.kind === 'multiple_choice') {
			return Promise.resolve(response.kind === 'multiple_choice'
				? validateMultipleChoiceActivity(activity, response.optionId)
				: { correct: false, feedback: 'Choose one of the available answers.' })
		}
		if (response.kind !== 'short_answer') {
			return Promise.resolve({ correct: false, feedback: 'Describe the code-level implementation step in your own words.' })
		}
		const toolDetails = JSON.stringify({
			name: toolMessage.name,
			params: toolMessage.params,
			rawParams: toolMessage.rawParams,
			mcpServerName: toolMessage.mcpServerName,
		}, null, 2)
		const systemMessage = [
			'You are checking whether a learner understands a code-level implementation concept before an edit is applied.',
			'Grade very leniently and use discretion. This is a lightweight reflection check, not an exam.',
			'Default to correct when the response is plausible, relevant, or demonstrates partial understanding.',
			'Accept brief answers, informal wording, different terminology, incomplete explanations, and reasonable alternative implementation approaches.',
			'Only mark incorrect when the response is meaningless filler, unrelated to the question, or clearly contradicts the shown code or implementation concept.',
			'If uncertain, mark correct.',
			'Return only JSON in this exact shape: {"correct": boolean, "feedback": string}.',
			'If the learner is incorrect, give a concise hint rather than the answer.'
		].join('\n')
		const validationPrompt = [
			'Original user request:', context.userRequest || '(No user request was available.)', '',
			'Visible assistant summary:', context.assistantSummary || '(No assistant explanation was available.)', '',
			'Hidden implementation details for consistency checking only:', toolDetails, '',
			'Code-level learning question:', activity.prompt, '',
			'Expected answer rubric:', activity.expectedAnswer, '',
			'Learner response:', response.answer,
		].join('\n')
		const fallbackResult = () => isSubstantiveLearningAnswer(response.answer)
			? { correct: true as const, feedback: 'That is a reasonable implementation explanation.' }
			: { correct: false as const, feedback: 'Add a little more about the code or implementation pattern.' }
		return new Promise(resolve => {
			const { modelSelection, modelSelectionOptions } = this.currentModelSelectionProps()
			const { messages, separateSystemMessage } = this.convertToLLMMessagesService.prepareLLMSimpleMessages({
				simpleMessages: [{ role: 'user', content: validationPrompt }],
				systemMessage,
				modelSelection,
				featureName: 'Chat',
			})
			const requestId = this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages,
				separateSystemMessage,
				chatMode: null,
				modelSelection,
				modelSelectionOptions,
				overridesOfModel: this.settingsService.state.overridesOfModel,
				onText: () => { },
				onFinalMessage: ({ fullText }) => resolve(this.extractValidation(fullText, response.answer)),
				onError: () => resolve(fallbackResult()),
				onAbort: () => resolve(fallbackResult()),
				logging: { loggingName: 'Chat - Validate Learning Answer', loggingExtras: { threadId: context.threadId, toolName: toolMessage.name } },
			})
			if (!requestId) resolve(fallbackResult())
		})
	}

	private extractValidation(fullText: string, learnerAnswer: string): LearningAnswerValidationResult {
		const withoutFence = fullText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
		const jsonMatch = withoutFence.match(/\{[\s\S]*\}/)
		try {
			const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : withoutFence) as { correct?: unknown; feedback?: unknown }
			if (parsed.correct !== true && parsed.correct !== false) {
				return isSubstantiveLearningAnswer(learnerAnswer)
					? { correct: true, feedback: 'That is a reasonable implementation explanation.' }
					: { correct: false, feedback: 'Add a little more about the code or implementation pattern.' }
			}
			return {
				correct: parsed.correct,
				feedback: typeof parsed.feedback === 'string' && parsed.feedback.trim()
					? parsed.feedback.trim()
					: parsed.correct ? 'Looks good.' : 'Add a little more about the relevant code or implementation pattern.'
			}
		}
		catch {
			return isSubstantiveLearningAnswer(learnerAnswer)
				? { correct: true, feedback: 'That is a reasonable implementation explanation.' }
				: { correct: false, feedback: 'Add a little more about the code or implementation pattern.' }
		}
	}
}

registerSingleton(IChatQuizService, ChatQuizService, InstantiationType.Eager);
