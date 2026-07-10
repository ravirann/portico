/** Barrel of every saved capture fixture the eval suite scores. */
import type { CaptureFixture } from "../score.js";
import { cleanWizardFixture } from "./clean-wizard.js";
import { blobNoiseWizardFixture } from "./blob-noise-wizard.js";

export { cleanWizardFixture } from "./clean-wizard.js";
export { blobNoiseWizardFixture } from "./blob-noise-wizard.js";

export const ALL_FIXTURES: readonly CaptureFixture[] = [cleanWizardFixture, blobNoiseWizardFixture];
