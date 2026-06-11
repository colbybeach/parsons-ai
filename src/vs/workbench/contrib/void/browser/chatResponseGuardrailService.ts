/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License v2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ChatMode, ModelSelection } from '../common/voidSettingsTypes.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';

export type EducationResponseStyle = 'concept_explain' | 'guided_design' | 'pseudocode_only' | 'refuse_exact_solution'

export type ResponseGuardrailContext = {
	threadId: string;
	chatMode: ChatMode;
	modelSelection: ModelSelection | null;
	recentContext: string;
	userDisplayContent: string;
	userContent: string;
	selectionCount: number;
}

export interface IChatResponseGuardrailService {
	readonly _serviceBrand: undefined;
	classifyResponseStyle(context: ResponseGuardrailContext): Promise<EducationResponseStyle | null>;
	rewriteAgentResponse(opts: {
		threadId: string;
		modelSelection: ModelSelection | null;
		style: EducationResponseStyle;
		userRequest: string;
		originalResponse: string;
	}): Promise<string>;
}

export const IChatResponseGuardrailService = createDecorator<IChatResponseGuardrailService>('voidChatResponseGuardrailService');

export const extractEducationResponseStyleJSON = (fullText: string): EducationResponseStyle => {
	const withoutFence = fullText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
	const jsonMatch = withoutFence.match(/\{[\s\S]*\}/)
	try {
		const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : withoutFence) as { style?: unknown }
		if (parsed.style === 'concept_explain') return 'concept_explain'
		if (parsed.style === 'guided_design') return 'guided_design'
		if (parsed.style === 'pseudocode_only') return 'pseudocode_only'
		if (parsed.style === 'refuse_exact_solution') return 'refuse_exact_solution'
		return 'guided_design'
	}
	catch {
		if (withoutFence.includes('concept_explain')) return 'concept_explain'
		if (withoutFence.includes('pseudocode_only')) return 'pseudocode_only'
		if (withoutFence.includes('refuse_exact_solution')) return 'refuse_exact_solution'
		return 'guided_design'
	}
}

export const educationGuardrailSystemMessage = (style: EducationResponseStyle): string => {
	if (style === 'concept_explain') {
		return [
			'Education response mode: concept explain.',
			'Give a direct, helpful conceptual answer with examples when appropriate.',
			'You may include small illustrative examples, including code, as long as they are general-purpose, brief, and not tailored to the user\'s exact codebase.',
			'Do not provide a full copy-paste-ready implementation.'
		].join('\n')
	}
	if (style === 'guided_design') {
		return [
			'Education response mode: guided design.',
			'Explain the approach, moving parts, and tradeoffs without giving a copy-paste-ready implementation.',
			'Do not provide fenced code blocks, imports, full function bodies, or exact project-specific code.',
			'Use bullets, short explanations, and implementation steps instead of runnable code.'
		].join('\n')
	}
	if (style === 'pseudocode_only') {
		return [
			'Education response mode: pseudocode only.',
			'Do not provide runnable code, fenced code blocks, imports, exact JSX, exact CSS, exact TypeScript, or project-specific implementation.',
			'You may provide high-level pseudocode or placeholder structure only.'
		].join('\n')
	}
	return [
		'Education response mode: refuse exact solution.',
		'Do not provide copy-paste-ready code, exact patches, exact replacement text, or precise line-by-line implementation.',
		'Instead, briefly explain the concept, give a hint, and offer a checklist of what to think through next.',
		'Do not use fenced code blocks.'
	].join('\n')
}

export const sanitizeEducationalResponse = (style: EducationResponseStyle, fullText: string): string => {
	if (style === 'concept_explain') return fullText
	const strippedCodeBlocks = fullText.replace(/```[\s\S]*?```/g, style === 'guided_design'
		? 'Code example omitted so you can work through the implementation yourself.'
		: 'Pseudocode omitted to keep this from turning into a copy-paste solution.')
	const strippedIntegrationDirections = strippedCodeBlocks
		.replace(/create a new file at[^\n]*/gi, 'Think about where a component like this would live in your project structure.')
		.replace(/paste (in|this|something like this)[^\n]*/gi, 'Try sketching the structure yourself before writing the code.')
		.replace(/replace that component entirely[^\n]*/gi, 'Decide whether you want to adapt the existing component or create a new one.')
		.replace(/drop anywhere in your [^\n]*/gi, 'Use the concept in the place that makes the most sense in your UI.')
	if (style === 'guided_design') return strippedIntegrationDirections
	return strippedIntegrationDirections
		.replace(/^\s*(import|export|const|let|var|function|class)\b.*$/gm, '')
		.trim()
}

export const agentCompletionSystemMessage = [
	'Post-implementation response mode.',
	'A tool has just completed successfully. Continue using tools if more work is required.',
	'If the requested work is complete, respond with a concise completion update in past tense.',
	'Start with a clear completion phrase such as "Done." or "Implemented."',
	'Summarize what changed and mention verification when known.',
	'Do not provide pseudocode, future-tense implementation instructions, or describe how the user could implement work that has already been applied.'
].join('\n')

export const likelyNeedsEducationalRewrite = (style: EducationResponseStyle, fullText: string): boolean => {
	if (style === 'concept_explain') return false
	const lowered = fullText.toLowerCase()
	if (lowered.includes('here’s a complete') || lowered.includes("here's a complete")) return true
	if (lowered.includes('self-contained')) return true
	if (lowered.includes('create (or update)')) return true
	if (lowered.includes('import and use it')) return true
	if (lowered.includes('drop into your')) return true
	if (/```[\s\S]*?```/.test(fullText)) return true
	if (/create a new file at/i.test(fullText)) return true
	if (/paste (in|this|something like this)/i.test(fullText)) return true
	if (style === 'pseudocode_only' && /(tsx|jsx|css|typescript|react app|tailwind app)/i.test(fullText)) return true
	return false
}

class ChatResponseGuardrailService implements IChatResponseGuardrailService {
	readonly _serviceBrand: undefined;

	constructor(
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IVoidSettingsService private readonly settingsService: IVoidSettingsService,
		@IConvertToLLMMessageService private readonly convertToLLMMessagesService: IConvertToLLMMessageService,
	) { }

	classifyResponseStyle(context: ResponseGuardrailContext): Promise<EducationResponseStyle | null> {
		if (context.modelSelection === null) return Promise.resolve(null)
		const modelSelection = context.modelSelection
		const systemMessage = [
			'Classify the learner request for an educational coding assistant.',
			'Return only JSON in this exact shape: {"style": "concept_explain" | "guided_design" | "pseudocode_only" | "refuse_exact_solution"}.',
			'Use "concept_explain" for concepts, syntax, definitions, comparisons, and short general examples.',
			'Use "guided_design" when the user wants to build something and should get structure, steps, and tradeoffs but not runnable code.',
			'Use "pseudocode_only" when the request would otherwise invite a nearly copy-pasteable generic implementation.',
			'Use "refuse_exact_solution" when the user is asking for exact implementation details or a direct solution they could paste in.',
			'In agent mode, classify the user-visible explanation. Tool execution approval is handled separately.',
			'In agent mode, if the user asks the assistant to build, implement, add, or wire something up, prefer "pseudocode_only" or "refuse_exact_solution".'
		].join('\n')
		const prompt = [
			'Chat mode:', context.chatMode, '',
			'Recent conversation context:', context.recentContext || '(No earlier context.)', '',
			'Latest user-visible request:', context.userDisplayContent || '(empty)', '',
			'Latest user request with attached context summary:', context.userContent || context.userDisplayContent || '(empty)', '',
			'Number of attached selections:', String(context.selectionCount),
		].join('\n')
		return new Promise(resolve => {
			const { messages, separateSystemMessage } = this.convertToLLMMessagesService.prepareLLMSimpleMessages({
				simpleMessages: [{ role: 'user', content: prompt }],
				systemMessage,
				modelSelection,
				featureName: 'Chat',
			})
			const modelSelectionOptions = this.settingsService.state.optionsOfModelSelection.Chat[modelSelection.providerName]?.[modelSelection.modelName]
			const requestId = this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages,
				separateSystemMessage,
				chatMode: null,
				modelSelection,
				modelSelectionOptions,
				overridesOfModel: this.settingsService.state.overridesOfModel,
				onText: () => { },
				onFinalMessage: ({ fullText }) => resolve(extractEducationResponseStyleJSON(fullText)),
				onError: () => resolve('pseudocode_only'),
				onAbort: () => resolve('pseudocode_only'),
				logging: { loggingName: 'Chat - Classify Education Response Style', loggingExtras: { threadId: context.threadId, chatMode: context.chatMode } },
			})
			if (!requestId) resolve('pseudocode_only')
		})
	}

	rewriteAgentResponse(opts: {
		threadId: string;
		modelSelection: ModelSelection | null;
		style: EducationResponseStyle;
		userRequest: string;
		originalResponse: string;
	}): Promise<string> {
		if (opts.modelSelection === null) return Promise.resolve(sanitizeEducationalResponse(opts.style, opts.originalResponse))
		const modelSelection = opts.modelSelection
		const systemMessage = [
			'Rewrite the assistant response for an educational coding product.',
			'Preserve usefulness while removing copy-paste-ready implementation guidance.',
			'Do not provide file paths, fenced code blocks, imports, exact project code, or step-by-step integration instructions.',
			'Do not mention internal tools, policies, sanitization, or that you are rewriting anything.',
			'Return only the rewritten assistant response as plain text.'
		].join('\n')
		const prompt = [
			'Latest user request:', opts.userRequest || '(empty)', '',
			'Current educational mode:', opts.style, '',
			'Assistant draft to rewrite:', opts.originalResponse,
		].join('\n')
		return new Promise(resolve => {
			const { messages, separateSystemMessage } = this.convertToLLMMessagesService.prepareLLMSimpleMessages({
				simpleMessages: [{ role: 'user', content: prompt }],
				systemMessage,
				modelSelection,
				featureName: 'Chat',
			})
			const modelSelectionOptions = this.settingsService.state.optionsOfModelSelection.Chat[modelSelection.providerName]?.[modelSelection.modelName]
			const fallback = () => sanitizeEducationalResponse(opts.style, opts.originalResponse)
			const requestId = this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages,
				separateSystemMessage,
				chatMode: null,
				modelSelection,
				modelSelectionOptions,
				overridesOfModel: this.settingsService.state.overridesOfModel,
				onText: () => { },
				onFinalMessage: ({ fullText }) => resolve(fullText.trim() || fallback()),
				onError: () => resolve(fallback()),
				onAbort: () => resolve(fallback()),
				logging: { loggingName: 'Chat - Rewrite Educational Agent Response', loggingExtras: { threadId: opts.threadId, style: opts.style } },
			})
			if (!requestId) resolve(fallback())
		})
	}
}

registerSingleton(IChatResponseGuardrailService, ChatResponseGuardrailService, InstantiationType.Eager);
