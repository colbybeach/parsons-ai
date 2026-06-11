/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License v2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type LearningAnswerValidationResult =
	| { correct: true; feedback: string }
	| { correct: false; feedback: string }

export type LearningActivity =
	| {
		version: 1;
		kind: 'multiple_choice';
		prompt: string;
		context?: { title?: string; language?: string; code: string };
		options: { id: string; label: string; format: 'text' | 'code' }[];
		correctOptionId: string;
		explanation: string;
	}
	| {
		version: 1;
		kind: 'short_answer';
		prompt: string;
		context?: { title?: string; language?: string; code: string };
		expectedAnswer: string;
	}

export type LearningActivityResponse =
	| { kind: 'multiple_choice'; optionId: string }
	| { kind: 'short_answer'; answer: string }
