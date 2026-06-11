/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { defaultModelsOfProvider, getModelCapabilities } from '../../common/modelCapabilities.js';
import { ProviderName } from '../../common/parsonsSettingsTypes.js';

suite('Parsons - Model Capabilities', () => {
	test('every curated default model has explicit capabilities', () => {
		for (const [providerName, modelNames] of Object.entries(defaultModelsOfProvider)) {
			for (const modelName of modelNames) {
				const capabilities = getModelCapabilities(providerName as ProviderName, modelName, undefined);
				assert.strictEqual(
					capabilities.isUnrecognizedModel,
					false,
					`${providerName}/${modelName} is listed as a default without explicit capabilities`
				);
			}
		}
	});

	test('Gemini 3 uses named thinking levels', () => {
		const capabilities = getModelCapabilities('gemini', 'gemini-3.5-flash', undefined);
		const slider = capabilities.reasoningCapabilities && capabilities.reasoningCapabilities.reasoningSlider;

		assert.ok(slider);
		assert.strictEqual(slider.type, 'effort_slider');
		assert.deepStrictEqual(slider.values, ['minimal', 'low', 'medium', 'high']);
	});
});
