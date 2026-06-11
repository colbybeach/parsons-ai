/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { mountFnGenerator } from '../util/mountFnGenerator.js'
import { ParsonsCommandBarMain } from './ParsonsCommandBar.js'
import { ParsonsSelectionHelperMain } from './ParsonsSelectionHelper.js'

export const mountParsonsCommandBar = mountFnGenerator(ParsonsCommandBarMain)

export const mountParsonsSelectionHelper = mountFnGenerator(ParsonsSelectionHelperMain)

