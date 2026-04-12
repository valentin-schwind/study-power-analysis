(function (global) {
    "use strict";

    const stats = new Statistics([], {}, { suppressWarnings: true });
    const DEFAULT_ALPHA = 0.05;
    const DEFAULT_TARGET_POWER = 0.8;
    const DEFAULT_WITHIN_CORRELATION = 0.5;
    const DEFAULT_SAMPLE_SIZE_STEP = 1;
    const DEFAULT_INTERACTION_HEURISTIC_WEIGHT = 0.15;
    const MAX_SEARCH_PARTICIPANTS = 2000;
    const criticalFCache = new Map();

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function roundTo(value, digits) {
        const factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
    }

    function product(values) {
        return values.reduce(function (total, value) {
            return total * value;
        }, 1);
    }

    function sum(values) {
        return values.reduce(function (total, value) {
            return total + value;
        }, 0);
    }

    function average(values) {
        return values.length === 0 ? 0 : sum(values) / values.length;
    }

    function buildIdentityMatrix(size) {
        const matrix = [];

        for (let row = 0; row < size; row++) {
            const currentRow = [];

            for (let column = 0; column < size; column++) {
                currentRow.push(row === column ? 1 : 0);
            }

            matrix.push(currentRow);
        }

        return matrix;
    }

    function buildAveragingMatrix(size) {
        const value = 1 / size;
        const matrix = [];

        for (let row = 0; row < size; row++) {
            const currentRow = [];

            for (let column = 0; column < size; column++) {
                currentRow.push(value);
            }

            matrix.push(currentRow);
        }

        return matrix;
    }

    function subtractMatrices(left, right) {
        return left.map(function (row, rowIndex) {
            return row.map(function (value, columnIndex) {
                return value - right[rowIndex][columnIndex];
            });
        });
    }

    function kroneckerProduct(left, right) {
        const matrix = [];

        for (let leftRow = 0; leftRow < left.length; leftRow++) {
            for (let rightRow = 0; rightRow < right.length; rightRow++) {
                const currentRow = [];

                for (let leftColumn = 0; leftColumn < left[leftRow].length; leftColumn++) {
                    for (let rightColumn = 0; rightColumn < right[rightRow].length; rightColumn++) {
                        currentRow.push(left[leftRow][leftColumn] * right[rightRow][rightColumn]);
                    }
                }

                matrix.push(currentRow);
            }
        }

        return matrix;
    }

    function multiplyMatrixVector(matrix, vector) {
        return matrix.map(function (row) {
            let total = 0;

            for (let index = 0; index < row.length; index++) {
                total += row[index] * vector[index];
            }

            return total;
        });
    }

    function enumerateLevelCombinations(levelCounts) {
        if (levelCounts.length === 0) {
            return [[]];
        }

        const combinations = [];

        function step(depth, current) {
            if (depth === levelCounts.length) {
                combinations.push(current.slice());
                return;
            }

            for (let level = 0; level < levelCounts[depth]; level++) {
                current.push(level);
                step(depth + 1, current);
                current.pop();
            }
        }

        step(0, []);

        return combinations;
    }

    function createSeededRandom(seed) {
        if (typeof Math.seedrandom === "function") {
            const generator = new Math.seedrandom(String(seed));

            return function () {
                return generator();
            };
        }

        let state = 0;
        const seedText = String(seed || 0);

        for (let index = 0; index < seedText.length; index++) {
            state = ((state << 5) - state + seedText.charCodeAt(index)) >>> 0;
        }

        if (state === 0) {
            state = 0x6d2b79f5;
        }

        return function () {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            return (state >>> 0) / 4294967296;
        };
    }

    function randomNormal(randomSource, mean, standardDeviation) {
        let u1 = 0;
        let u2 = 0;

        while (u1 <= Number.EPSILON) {
            u1 = randomSource();
        }

        while (u2 <= Number.EPSILON) {
            u2 = randomSource();
        }

        const magnitude = Math.sqrt(-2 * Math.log(u1));
        const zValue = magnitude * Math.cos(2 * Math.PI * u2);

        return mean + standardDeviation * zValue;
    }

    function shuffleValues(values, seed) {
        const shuffled = values.slice();
        const randomSource = createSeededRandom(seed);

        for (let index = shuffled.length - 1; index > 0; index--) {
            const swapIndex = Math.floor(randomSource() * (index + 1));
            const temp = shuffled[index];
            shuffled[index] = shuffled[swapIndex];
            shuffled[swapIndex] = temp;
        }

        return shuffled;
    }

    function powerSet(factors) {
        const effects = [];
        const total = Math.pow(2, factors.length);

        for (let mask = 1; mask < total; mask++) {
            const current = [];

            for (let index = 0; index < factors.length; index++) {
                if ((mask & (1 << index)) !== 0) {
                    current.push(index);
                }
            }

            effects.push(current);
        }

        return effects;
    }

    function buildCanonicalLevelProfile(levelCount) {
        if (levelCount <= 1) {
            return [0];
        }

        if (levelCount === 2) {
            return [-0.5, 0.5];
        }

        if (levelCount === 3) {
            return [-0.5, 0, 0.5];
        }

        if (levelCount === 4) {
            return [-0.5, -1 / 6, 1 / 6, 0.5];
        }

        const profile = [];

        for (let index = 0; index < levelCount; index++) {
            profile.push(index / (levelCount - 1) - 0.5);
        }

        return profile;
    }

    function getFactorPriority(factor, index) {
        return {
            index: index,
            factor: factor,
            typePriority: factor.type === "w" ? 0 : 1,
            levelPriority: -factor.levels.length,
        };
    }

    function buildPrioritizedCellOrder(factors) {
        const prioritizedFactors = factors
            .map(function (factor, index) {
                return getFactorPriority(factor, index);
            })
            .sort(function (left, right) {
                if (left.typePriority !== right.typePriority) {
                    return left.typePriority - right.typePriority;
                }

                if (left.levelPriority !== right.levelPriority) {
                    return left.levelPriority - right.levelPriority;
                }

                return left.index - right.index;
            });
        const orderedCombinations = enumerateLevelCombinations(
            prioritizedFactors.map(function (entry) {
                return entry.factor.levels.length;
            }),
        );
        const getCellIndex = createCellIndexLookup(factors);

        return orderedCombinations.map(function (orderedCombination) {
            const originalCombination = new Array(factors.length);

            for (let factorIndex = 0; factorIndex < prioritizedFactors.length; factorIndex++) {
                originalCombination[prioritizedFactors[factorIndex].index] = orderedCombination[factorIndex];
            }

            return getCellIndex(originalCombination);
        });
    }

    function buildLinearMeanPattern(factors, delta) {
        const totalCells = getTotalCellCount(factors);

        if (totalCells <= 1) {
            return [0];
        }

        const centeredMeans = new Array(totalCells).fill(0);
        const prioritizedCellOrder = buildPrioritizedCellOrder(factors);

        for (let rank = 0; rank < prioritizedCellOrder.length; rank++) {
            centeredMeans[prioritizedCellOrder[rank]] = (rank / (totalCells - 1) - 0.5) * delta;
        }

        return centeredMeans;
    }

    function buildInteractionPattern(factors, levelProfiles, delta) {
        if (factors.length < 2 || delta <= Number.EPSILON) {
            return new Array(getTotalCellCount(factors)).fill(0);
        }

        const levelCombinations = enumerateLevelCombinations(
            factors.map(function (factor) {
                return factor.levels.length;
            }),
        );
        const interactionDefinitions = powerSet(factors).filter(function (effectDefinition) {
            return effectDefinition.length >= 2;
        });
        const rawPattern = levelCombinations.map(function (levelCombination) {
            let value = 0;

            for (let effectIndex = 0; effectIndex < interactionDefinitions.length; effectIndex++) {
                const includedFactors = interactionDefinitions[effectIndex];
                let component = 1 / Math.pow(2, includedFactors.length - 1);

                for (let factorIndex = 0; factorIndex < includedFactors.length; factorIndex++) {
                    const currentFactorIndex = includedFactors[factorIndex];
                    component *= levelProfiles[currentFactorIndex][levelCombination[currentFactorIndex]];
                }

                value += component;
            }

            return value;
        });
        const minimum = Math.min.apply(null, rawPattern);
        const maximum = Math.max.apply(null, rawPattern);
        const range = Math.max(maximum - minimum, Number.EPSILON);

        return rawPattern.map(function (value) {
            return ((value - minimum) / range - 0.5) * delta * DEFAULT_INTERACTION_HEURISTIC_WEIGHT * 2;
        });
    }

    function buildConditionMeans(factors, delta, explicitMeans) {
        const totalCells =
            factors.length === 0
                ? 1
                : product(
                      factors.map(function (factor) {
                          return factor.levels.length;
                      }),
                  );

        if (Array.isArray(explicitMeans) && explicitMeans.length === totalCells) {
            return explicitMeans.slice();
        }

        if (totalCells <= 1) {
            return [0];
        }

        const safeDelta = Math.max(0, Number(delta) || 0);
        const levelProfiles = factors.map(function (factor) {
            return buildCanonicalLevelProfile(factor.levels.length);
        });
        const basePattern = buildLinearMeanPattern(factors, safeDelta);
        const interactionPattern = buildInteractionPattern(factors, levelProfiles, safeDelta);

        return basePattern.map(function (value, index) {
            return value + interactionPattern[index];
        });
    }

    function getTotalCellCount(factors) {
        if (!factors || factors.length === 0) {
            return 1;
        }

        return product(
            factors.map(function (factor) {
                return factor.levels.length;
            }),
        );
    }

    function getBetweenCellCount(factors) {
        const betweenFactors = (factors || []).filter(function (factor) {
            return factor.type === "b";
        });

        if (betweenFactors.length === 0) {
            return 1;
        }

        return product(
            betweenFactors.map(function (factor) {
                return factor.levels.length;
            }),
        );
    }

    function roundUpToMultiple(value, step) {
        if (!isFinite(value) || value <= 0) {
            return step;
        }

        return Math.ceil(value / step) * step;
    }

    function normalizeFactors(rawFactors) {
        return (rawFactors || [])
            .map(function (factor) {
                return {
                    name: factor.name,
                    levels: factor.levels.slice(),
                    type: factor.type,
                };
            })
            .filter(function (factor) {
                return Array.isArray(factor.levels) && factor.levels.length >= 2;
            });
    }

    function parseStudyDesign(studyDesignString, labels) {
        const designTokens = (studyDesignString || "").split("*").filter(Boolean);
        const factors = [];
        let labelIndex = 0;

        for (let tokenIndex = 0; tokenIndex < designTokens.length; tokenIndex++) {
            const token = designTokens[tokenIndex].trim();
            const match = token.match(/^(\d+)([bw])$/i);

            if (!match) {
                continue;
            }

            const levelCount = parseInt(match[1], 10);
            const type = match[2].toLowerCase();
            const factorName = labels && labels[labelIndex] ? labels[labelIndex] : "Factor " + (tokenIndex + 1);
            labelIndex++;
            const levels = [];

            for (let levelIndex = 0; levelIndex < levelCount; levelIndex++) {
                levels.push(labels && labels[labelIndex] ? labels[labelIndex] : "Level " + (levelIndex + 1));
                labelIndex++;
            }

            factors.push({
                name: factorName,
                levels: levels,
                type: type,
            });
        }

        return normalizeFactors(factors);
    }

    function buildEffectDefinitions(factors) {
        const definitions = [];
        const effectIndices = powerSet(factors);

        for (let effectIndex = 0; effectIndex < effectIndices.length; effectIndex++) {
            const includedFactors = effectIndices[effectIndex];
            const matrices = [];
            const withinIndices = [];

            for (let factorIndex = 0; factorIndex < factors.length; factorIndex++) {
                const levelCount = factors[factorIndex].levels.length;
                const averagingMatrix = buildAveragingMatrix(levelCount);
                const centeredProjection = subtractMatrices(buildIdentityMatrix(levelCount), averagingMatrix);
                const included = includedFactors.indexOf(factorIndex) >= 0;

                matrices.push(included ? centeredProjection : averagingMatrix);

                if (included && factors[factorIndex].type === "w") {
                    withinIndices.push(factorIndex);
                }
            }

            const projection = matrices.reduce(function (current, matrix) {
                return current === null ? matrix : kroneckerProduct(current, matrix);
            }, null);
            const df1 = includedFactors.reduce(function (current, factorIndex) {
                return current * (factors[factorIndex].levels.length - 1);
            }, 1);
            const withinDf = withinIndices.reduce(function (current, factorIndex) {
                return current * (factors[factorIndex].levels.length - 1);
            }, 1);

            definitions.push({
                indices: includedFactors,
                label: includedFactors
                    .map(function (factorIndex) {
                        return factors[factorIndex].name;
                    })
                    .join(":"),
                projection: projection,
                df1: df1,
                hasWithin: withinIndices.length > 0,
                withinDf: withinDf,
            });
        }

        return definitions;
    }

    function fCdf(value, df1, df2) {
        if (!isFinite(value) || value <= 0) {
            return 0;
        }

        const ratio = (df1 * value) / (df1 * value + df2);
        return stats.regularisedBeta(clamp(ratio, 0, 1), df1 / 2, df2 / 2);
    }

    function fSurvival(value, df1, df2) {
        return 1 - fCdf(value, df1, df2);
    }

    function invertFCdf(probability, df1, df2) {
        const cacheKey = [roundTo(probability, 6), df1, df2].join("|");

        if (criticalFCache.has(cacheKey)) {
            return criticalFCache.get(cacheKey);
        }

        let lower = 0;
        let upper = 1;

        while (fCdf(upper, df1, df2) < probability && upper < 1e6) {
            upper *= 2;
        }

        for (let iteration = 0; iteration < 60; iteration++) {
            const middle = (lower + upper) / 2;
            const cdfValue = fCdf(middle, df1, df2);

            if (cdfValue < probability) {
                lower = middle;
            } else {
                upper = middle;
            }
        }

        const result = (lower + upper) / 2;
        criticalFCache.set(cacheKey, result);
        return result;
    }

    function noncentralFCdf(x, df1, df2, noncentrality) {
        if (noncentrality <= Number.EPSILON) {
            return fCdf(x, df1, df2);
        }

        const lambda = noncentrality / 2;
        let weight = Math.exp(-lambda);
        let cumulative = 0;

        for (let termIndex = 0; termIndex < 120; termIndex++) {
            cumulative += weight * fCdf(x, df1 + 2 * termIndex, df2);
            weight *= lambda / (termIndex + 1);

            if (weight < 1e-12) {
                break;
            }
        }

        return clamp(cumulative, 0, 1);
    }

    function chiSquareCdf(value, df) {
        if (!isFinite(value) || value <= 0) {
            return 0;
        }

        return stats.regularisedGamma(df / 2, value / 2);
    }

    function invertChiSquareCdf(probability, df) {
        let lower = 0;
        let upper = Math.max(1, df);

        while (chiSquareCdf(upper, df) < probability && upper < 1e6) {
            upper *= 2;
        }

        for (let iteration = 0; iteration < 60; iteration++) {
            const middle = (lower + upper) / 2;

            if (chiSquareCdf(middle, df) < probability) {
                lower = middle;
            } else {
                upper = middle;
            }
        }

        return (lower + upper) / 2;
    }

    function noncentralChiSquareCdf(value, df, noncentrality) {
        if (noncentrality <= Number.EPSILON) {
            return chiSquareCdf(value, df);
        }

        const lambda = noncentrality / 2;
        let poissonWeight = Math.exp(-lambda);
        let cumulative = 0;

        for (let termIndex = 0; termIndex < 160; termIndex++) {
            cumulative += poissonWeight * chiSquareCdf(value, df + 2 * termIndex);
            poissonWeight *= lambda / (termIndex + 1);

            if (poissonWeight < 1e-12) {
                break;
            }
        }

        return clamp(cumulative, 0, 1);
    }

    function approximateFPower(df1, df2, lambda, alpha) {
        const chiSquareThreshold = invertChiSquareCdf(1 - alpha, df1) * (df2 / Math.max(df2 - 2, 1));
        const power = 1 - noncentralChiSquareCdf(chiSquareThreshold, df1, lambda);

        return {
            criticalValue: chiSquareThreshold / df1,
            power: roundTo(clamp(power, 0, 1), 3),
        };
    }

    function buildLayout(factors, totalParticipants) {
        const betweenFactors = factors.filter(function (factor) {
            return factor.type === "b";
        });
        const withinFactors = factors.filter(function (factor) {
            return factor.type === "w";
        });
        const betweenCells = Math.max(
            1,
            product(
                betweenFactors.map(function (factor) {
                    return factor.levels.length;
                }),
            ),
        );
        const withinCells = Math.max(
            1,
            product(
                withinFactors.map(function (factor) {
                    return factor.levels.length;
                }),
            ),
        );
        const participantsPerBetweenCell = Math.max(2, Math.ceil(totalParticipants / betweenCells));
        const balancedParticipants = participantsPerBetweenCell * betweenCells;
        const betweenDf = Math.max(1, balancedParticipants - betweenCells);

        return {
            betweenFactors: betweenFactors,
            withinFactors: withinFactors,
            betweenCells: betweenCells,
            withinCells: withinCells,
            participantsPerBetweenCell: participantsPerBetweenCell,
            balancedParticipants: balancedParticipants,
            betweenDf: betweenDf,
        };
    }

    function createCellIndexLookup(factors) {
        const levelCounts = factors.map(function (factor) {
            return factor.levels.length;
        });
        const multipliers = [];
        let runningMultiplier = 1;

        for (let index = levelCounts.length - 1; index >= 0; index--) {
            multipliers[index] = runningMultiplier;
            runningMultiplier *= levelCounts[index];
        }

        return function (levelIndices) {
            let index = 0;

            for (let factorIndex = 0; factorIndex < levelIndices.length; factorIndex++) {
                index += levelIndices[factorIndex] * multipliers[factorIndex];
            }

            return index;
        };
    }

    function simulateObservedMeans(options) {
        const factors = options.factors;
        const means = options.means;
        const sd = options.sd;
        const withinCorrelation = clamp(options.withinCorrelation, 0, 0.95);
        const layout = options.layout;
        const randomSource = options.randomSource;
        const betweenCount = layout.betweenFactors.length;
        const withinCount = layout.withinFactors.length;
        const betweenCombinations = enumerateLevelCombinations(
            layout.betweenFactors.map(function (factor) {
                return factor.levels.length;
            }),
        );
        const withinCombinations = enumerateLevelCombinations(
            layout.withinFactors.map(function (factor) {
                return factor.levels.length;
            }),
        );
        const observedMeans = new Array(means.length).fill(0);
        const getCellIndex = createCellIndexLookup(factors);

        if (withinCount === 0) {
            const allCombinations = enumerateLevelCombinations(
                factors.map(function (factor) {
                    return factor.levels.length;
                }),
            );

            for (let cellIndex = 0; cellIndex < allCombinations.length; cellIndex++) {
                let total = 0;

                for (let participant = 0; participant < layout.participantsPerBetweenCell; participant++) {
                    total += randomNormal(randomSource, means[cellIndex], sd);
                }

                observedMeans[cellIndex] = total / layout.participantsPerBetweenCell;
            }

            return observedMeans;
        }

        const interceptSd = sd * Math.sqrt(withinCorrelation);
        const residualSd = sd * Math.sqrt(Math.max(1 - withinCorrelation, 1e-6));

        for (let betweenIndex = 0; betweenIndex < betweenCombinations.length; betweenIndex++) {
            const currentBetweenLevels = betweenCombinations[betweenIndex];
            const cellTotals = new Array(withinCombinations.length).fill(0);

            for (let participant = 0; participant < layout.participantsPerBetweenCell; participant++) {
                const subjectOffset = randomNormal(randomSource, 0, interceptSd);

                for (let withinIndex = 0; withinIndex < withinCombinations.length; withinIndex++) {
                    const currentWithinLevels = withinCombinations[withinIndex];
                    const levelIndices = [];
                    let betweenPointer = 0;
                    let withinPointer = 0;

                    for (let factorIndex = 0; factorIndex < factors.length; factorIndex++) {
                        if (factors[factorIndex].type === "b") {
                            levelIndices.push(currentBetweenLevels[betweenPointer]);
                            betweenPointer++;
                        } else {
                            levelIndices.push(currentWithinLevels[withinPointer]);
                            withinPointer++;
                        }
                    }

                    const globalIndex = getCellIndex(levelIndices);
                    const value = means[globalIndex] + subjectOffset + randomNormal(randomSource, 0, residualSd);
                    cellTotals[withinIndex] += value;
                }
            }

            for (let withinIndex = 0; withinIndex < withinCombinations.length; withinIndex++) {
                const currentWithinLevels = withinCombinations[withinIndex];
                const levelIndices = [];
                let betweenPointer = 0;
                let withinPointer = 0;

                for (let factorIndex = 0; factorIndex < factors.length; factorIndex++) {
                    if (factors[factorIndex].type === "b") {
                        levelIndices.push(currentBetweenLevels[betweenPointer]);
                        betweenPointer++;
                    } else {
                        levelIndices.push(currentWithinLevels[withinPointer]);
                        withinPointer++;
                    }
                }

                const globalIndex = getCellIndex(levelIndices);
                observedMeans[globalIndex] = cellTotals[withinIndex] / layout.participantsPerBetweenCell;
            }
        }

        return observedMeans;
    }

    function getEffectErrorVariance(effectDefinition, sd, withinCorrelation) {
        const baseVariance = Math.pow(sd, 2);

        if (!effectDefinition.hasWithin) {
            return baseVariance;
        }

        return baseVariance * Math.max(1 - withinCorrelation, 1e-6);
    }

    function computeEffectStatistics(effectDefinition, means, layout, sd, withinCorrelation, alpha) {
        const projectedMeans = multiplyMatrixVector(effectDefinition.projection, means);
        const signalSumSquares = sum(
            projectedMeans.map(function (value) {
                return value * value;
            }),
        );
        const errorVariance = getEffectErrorVariance(effectDefinition, sd, withinCorrelation);
        const cohenFSquared = errorVariance <= Number.EPSILON ? 0 : signalSumSquares / (means.length * errorVariance);
        const cohenF = Math.sqrt(Math.max(cohenFSquared, 0));
        const partialEtaSquared = cohenFSquared <= 0 ? 0 : cohenFSquared / (1 + cohenFSquared);
        const df2 = Math.max(1, layout.betweenDf * effectDefinition.withinDf);
        const lambda = errorVariance <= Number.EPSILON ? 0 : (layout.participantsPerBetweenCell * signalSumSquares) / errorVariance;
        const powerStatistics = approximateFPower(effectDefinition.df1, df2, lambda, alpha);

        return {
            cohenFSquared: cohenFSquared,
            cohenF: cohenF,
            partialEtaSquared: partialEtaSquared,
            df2: df2,
            criticalValue: powerStatistics.criticalValue,
            lambda: lambda,
            power: powerStatistics.power,
        };
    }

    function getDominantEffectSummary(effectSummaries) {
        if (!effectSummaries || effectSummaries.length === 0) {
            return null;
        }

        const mainEffects = effectSummaries.filter(function (summary) {
            return summary.definition.indices.length === 1;
        });
        const candidateEffects = mainEffects.length > 0 ? mainEffects : effectSummaries;

        return candidateEffects.reduce(function (best, current) {
            if (!best || (current.cohenF || 0) > (best.cohenF || 0)) {
                return current;
            }

            return best;
        }, null);
    }

    function prepareEffectSummaries(factors, means, layout, sd, withinCorrelation, alpha) {
        const effects = buildEffectDefinitions(factors);

        return effects.map(function (effectDefinition) {
            const statistics = computeEffectStatistics(effectDefinition, means, layout, sd, withinCorrelation, alpha);

            return {
                definition: effectDefinition,
                partialEtaSquared: statistics.partialEtaSquared,
                cohenF: statistics.cohenF,
                df2: statistics.df2,
                criticalValue: statistics.criticalValue,
                lambda: statistics.lambda,
                power: statistics.power,
            };
        });
    }

    function estimateAnovaPower(options) {
        const factors = normalizeFactors(options.factors);

        if (factors.length === 0) {
            return {
                rows: [],
                sampleSize: 0,
                simulations: 0,
            };
        }

        const sd = Math.max(0.001, Number(options.sd) || 0.001);
        const alpha = Number(options.alpha) || DEFAULT_ALPHA;
        const withinCorrelation = clamp(Number(options.withinCorrelation) || DEFAULT_WITHIN_CORRELATION, 0, 0.95);
        const layout = buildLayout(factors, Number(options.totalParticipants) || getTotalCellCount(factors));
        const means = buildConditionMeans(factors, options.delta, options.means);
        const effectSummaries = prepareEffectSummaries(factors, means, layout, sd, withinCorrelation, alpha);

        return {
            means: means,
            sampleSize: layout.balancedParticipants,
            simulations: 0,
            rows: effectSummaries.map(function (effectSummary) {
                return {
                    _row: effectSummary.definition.label,
                    power: roundTo(effectSummary.power * 100, 1),
                    partial_eta_squared: roundTo(effectSummary.partialEtaSquared, 3),
                    cohen_f: roundTo(effectSummary.cohenF, 3),
                };
            }),
        };
    }

    function estimateAnovaEffectSizes(options) {
        const factors = normalizeFactors(options.factors);

        if (factors.length === 0) {
            return {
                representative: null,
                rows: [],
            };
        }

        const sd = Math.max(0.001, Number(options.sd) || 0.001);
        const alpha = Number(options.alpha) || DEFAULT_ALPHA;
        const withinCorrelation = clamp(Number(options.withinCorrelation) || DEFAULT_WITHIN_CORRELATION, 0, 0.95);
        const layout = buildLayout(factors, Math.max(2, Number(options.totalParticipants) || getTotalCellCount(factors)));
        const means = buildConditionMeans(factors, options.delta, options.means);
        const effectSummaries = prepareEffectSummaries(factors, means, layout, sd, withinCorrelation, alpha);
        const representative = getDominantEffectSummary(effectSummaries);

        return {
            representative: representative
                ? {
                      label: representative.definition.label,
                      cohenF: representative.cohenF,
                      partialEtaSquared: representative.partialEtaSquared,
                  }
                : null,
            rows: effectSummaries.map(function (effectSummary) {
                return {
                    label: effectSummary.definition.label,
                    cohenF: effectSummary.cohenF,
                    partialEtaSquared: effectSummary.partialEtaSquared,
                };
            }),
        };
    }

    function estimateRepresentativeEffectAtSampleSize(factors, means, sampleSize, sd, withinCorrelation, alpha) {
        const layout = buildLayout(factors, sampleSize);
        const effectSummaries = prepareEffectSummaries(factors, means, layout, sd, withinCorrelation, alpha);

        return {
            layout: layout,
            effectSummaries: effectSummaries,
            representative: getDominantEffectSummary(effectSummaries),
        };
    }

    function estimateSampleSizeForAnova(options) {
        const factors = normalizeFactors(options.factors);

        if (factors.length === 0) {
            return {
                sampleSize: 0,
                powerResult: { rows: [] },
            };
        }

        const sd = Math.max(0.001, Number(options.sd) || 0.001);
        const alpha = Number(options.alpha) || DEFAULT_ALPHA;
        const withinCorrelation = clamp(Number(options.withinCorrelation) || DEFAULT_WITHIN_CORRELATION, 0, 0.95);
        const targetPower = clamp(Number(options.targetPower) || DEFAULT_TARGET_POWER, 0.01, 0.999);
        const totalCells = getTotalCellCount(factors);
        const betweenCells = getBetweenCellCount(factors);
        const means = buildConditionMeans(factors, options.delta, options.means);
        const step = Math.max(DEFAULT_SAMPLE_SIZE_STEP, totalCells);
        const minimumParticipants = roundUpToMultiple(Math.max(totalCells, betweenCells * 2), step);

        let lower = minimumParticipants;
        let upper = minimumParticipants;
        let upperResult = estimateRepresentativeEffectAtSampleSize(factors, means, upper, sd, withinCorrelation, alpha);

        while (upperResult.representative && upperResult.representative.power < targetPower && upper < MAX_SEARCH_PARTICIPANTS) {
            lower = upper + step;
            upper = roundUpToMultiple(Math.min(MAX_SEARCH_PARTICIPANTS, upper * 2), step);
            upperResult = estimateRepresentativeEffectAtSampleSize(factors, means, upper, sd, withinCorrelation, alpha);

            if (upper === MAX_SEARCH_PARTICIPANTS) {
                break;
            }
        }

        let estimatedParticipants = upper;

        if (upperResult.representative && upperResult.representative.power >= targetPower) {
            let left = minimumParticipants;
            let right = upper;

            while (left <= right) {
                const middle = roundUpToMultiple(Math.floor((left + right) / 2), step);
                const candidate = estimateRepresentativeEffectAtSampleSize(factors, means, middle, sd, withinCorrelation, alpha);

                if (candidate.representative && candidate.representative.power >= targetPower) {
                    estimatedParticipants = middle;
                    right = middle - step;
                } else {
                    left = middle + step;
                }
            }
        }

        estimatedParticipants = Math.min(MAX_SEARCH_PARTICIPANTS, roundUpToMultiple(estimatedParticipants, step));

        return {
            sampleSize: estimatedParticipants,
            powerResult: estimateAnovaPower({
                factors: factors,
                means: means,
                sd: sd,
                totalParticipants: estimatedParticipants,
                alpha: alpha,
                withinCorrelation: withinCorrelation,
            }),
        };
    }

    function transpose(matrix) {
        return matrix[0].map(function (_, columnIndex) {
            return matrix.map(function (row) {
                return row[columnIndex];
            });
        });
    }

    function multiplyMatrices(left, right) {
        const result = [];

        for (let row = 0; row < left.length; row++) {
            const currentRow = [];

            for (let column = 0; column < right[0].length; column++) {
                let total = 0;

                for (let index = 0; index < right.length; index++) {
                    total += left[row][index] * right[index][column];
                }

                currentRow.push(total);
            }

            result.push(currentRow);
        }

        return result;
    }

    function invertMatrix(matrix) {
        const size = matrix.length;
        const augmented = matrix.map(function (row, rowIndex) {
            const identityRow = new Array(size).fill(0);
            identityRow[rowIndex] = 1;
            return row.slice().concat(identityRow);
        });

        for (let pivot = 0; pivot < size; pivot++) {
            let maxRow = pivot;

            for (let row = pivot + 1; row < size; row++) {
                if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[maxRow][pivot])) {
                    maxRow = row;
                }
            }

            if (Math.abs(augmented[maxRow][pivot]) < 1e-10) {
                return null;
            }

            if (maxRow !== pivot) {
                const temp = augmented[pivot];
                augmented[pivot] = augmented[maxRow];
                augmented[maxRow] = temp;
            }

            const pivotValue = augmented[pivot][pivot];

            for (let column = 0; column < augmented[pivot].length; column++) {
                augmented[pivot][column] /= pivotValue;
            }

            for (let row = 0; row < size; row++) {
                if (row === pivot) {
                    continue;
                }

                const factor = augmented[row][pivot];

                for (let column = 0; column < augmented[row].length; column++) {
                    augmented[row][column] -= factor * augmented[pivot][column];
                }
            }
        }

        return augmented.map(function (row) {
            return row.slice(size);
        });
    }

    function multiplyMatrixAndVector(matrix, vector) {
        return matrix.map(function (row) {
            let total = 0;

            for (let index = 0; index < vector.length; index++) {
                total += row[index] * vector[index];
            }

            return total;
        });
    }

    function fitLinearModel(designMatrix, response) {
        const xTranspose = transpose(designMatrix);
        const xTx = multiplyMatrices(xTranspose, designMatrix);
        const inverse = invertMatrix(xTx);

        if (!inverse) {
            return null;
        }

        const xTy = multiplyMatrixAndVector(xTranspose, response);
        const coefficients = multiplyMatrixAndVector(inverse, xTy);
        const fitted = designMatrix.map(function (row) {
            let total = 0;

            for (let index = 0; index < row.length; index++) {
                total += row[index] * coefficients[index];
            }

            return total;
        });
        const responseMean = average(response);
        let sse = 0;
        let sst = 0;

        for (let index = 0; index < response.length; index++) {
            sse += Math.pow(response[index] - fitted[index], 2);
            sst += Math.pow(response[index] - responseMean, 2);
        }

        return {
            coefficients: coefficients,
            sse: sse,
            sst: sst,
        };
    }

    function getRegressionFsquared(delta, sd) {
        const safeSd = Math.max(sd, 0.001);
        const standardizedEffect = delta / safeSd;
        return Math.max(0.005, Math.pow(standardizedEffect / Math.SQRT2, 2));
    }

    function estimateRegressionModelStatistics(predictors, participants, delta, sd, alpha) {
        const numeratorDf = Math.max(1, predictors);
        const denominatorDf = Math.max(1, participants - predictors - 1);
        const fSquared = getRegressionFsquared(delta, sd);
        const lambda = fSquared * (numeratorDf + denominatorDf + 1);
        const rSquared = fSquared / (1 + fSquared);
        const powerStatistics = approximateFPower(numeratorDf, denominatorDf, lambda, alpha);

        return {
            numeratorDf: numeratorDf,
            denominatorDf: denominatorDf,
            fSquared: fSquared,
            rSquared: rSquared,
            lambda: lambda,
            criticalValue: powerStatistics.criticalValue,
            power: powerStatistics.power,
        };
    }

    function estimateRegressionPower(options) {
        const predictors = Math.max(1, parseInt(options.predictors, 10) || 1);
        const participants = Math.max(predictors + 3, parseInt(options.participants, 10) || predictors + 3);
        const alpha = Number(options.alpha) || DEFAULT_ALPHA;
        const modelStatistics = estimateRegressionModelStatistics(predictors, participants, Number(options.delta) || 0, Number(options.sd) || 0.001, alpha);
        const fSquared = modelStatistics.fSquared;
        const power = modelStatistics.power;

        return {
            predictors: predictors,
            participants: participants,
            fSquared: roundTo(modelStatistics.fSquared, 3),
            alpha: alpha,
            power: roundTo(modelStatistics.power, 3),
            tableRows: [
                { label: "Number of regression coefficients (predictors)", value: predictors },
                { label: "Numerator degrees of freedom (<i>u</i>)", value: modelStatistics.numeratorDf },
                { label: "Denominator degrees of freedom (<i>v</i>)", value: modelStatistics.denominatorDf },
                { label: "Effect size (<i>f²</i>)", value: roundTo(fSquared, 3) },
                { label: "Model <i>R<sup>2</sup></i>", value: roundTo(modelStatistics.rSquared, 3) },
                { label: "Significance level", value: roundTo(alpha, 3) },
                { label: "Statistical power", value: roundTo(clamp(modelStatistics.power, 0, 1) * 100, 1) + "%" },
            ],
        };
    }

    function estimateSampleSizeForRegression(options) {
        const predictors = Math.max(1, parseInt(options.predictors, 10) || 1);
        const targetPower = Number(options.targetPower) || DEFAULT_TARGET_POWER;
        const alpha = Number(options.alpha) || DEFAULT_ALPHA;
        const delta = Number(options.delta) || 0;
        const sd = Number(options.sd) || 0.001;
        const minimumParticipants = Math.max(predictors + 3, 8);

        let upperBound = minimumParticipants;
        let upperPower = estimateRegressionModelStatistics(predictors, upperBound, delta, sd, alpha).power;

        while (upperPower < targetPower && upperBound < MAX_SEARCH_PARTICIPANTS) {
            upperBound = Math.min(MAX_SEARCH_PARTICIPANTS, upperBound * 2);
            upperPower = estimateRegressionModelStatistics(predictors, upperBound, delta, sd, alpha).power;
        }

        let bestSampleSize = upperBound;

        if (upperPower >= targetPower) {
            let left = minimumParticipants;
            let right = upperBound;

            while (left <= right) {
                const middle = Math.floor((left + right) / 2);
                const middlePower = estimateRegressionModelStatistics(predictors, middle, delta, sd, alpha).power;

                if (middlePower >= targetPower) {
                    bestSampleSize = middle;
                    right = middle - 1;
                } else {
                    left = middle + 1;
                }
            }
        }

        return {
            sampleSize: bestSampleSize,
            powerResult: estimateRegressionPower({
                predictors: predictors,
                participants: bestSampleSize,
                delta: delta,
                sd: sd,
                alpha: alpha,
            }),
        };
    }

    global.StudyPowerEngine = {
        parseStudyDesign: parseStudyDesign,
        buildConditionMeans: buildConditionMeans,
        estimateAnovaEffectSizes: estimateAnovaEffectSizes,
        estimateAnovaPower: estimateAnovaPower,
        estimateSampleSizeForAnova: estimateSampleSizeForAnova,
        estimateRegressionPower: estimateRegressionPower,
        estimateSampleSizeForRegression: estimateSampleSizeForRegression,
    };
})(window);
