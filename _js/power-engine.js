(function (global) {
    "use strict";

    const stats = new Statistics([], {}, { suppressWarnings: true });
    const DEFAULT_ALPHA = 0.05;
    const DEFAULT_TARGET_POWER = 0.8;
    const DEFAULT_WITHIN_CORRELATION = 0.5;
    const MAX_SEARCH_PARTICIPANTS = 4000;
    const MAX_SEARCH_ITERATIONS = 32;
    const MAX_CURVE_POINTS = 30;
    const criticalFCache = new Map();
    const BETWEEN_WEIGHT_COEFFICIENTS = {
        intercept: 0.5566116,
        linear: 0.0283437,
        quadratic: -0.00218684,
    };

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

    function powerSet(items) {
        const subsets = [];
        const totalMasks = Math.pow(2, items.length);

        for (let mask = 1; mask < totalMasks; mask++) {
            const subset = [];

            for (let index = 0; index < items.length; index++) {
                if ((mask & (1 << index)) !== 0) {
                    subset.push(items[index]);
                }
            }

            subsets.push(subset);
        }

        return subsets;
    }

    function normalizeFactors(rawFactors) {
        return (rawFactors || [])
            .map(function (factor) {
                return {
                    name: factor.name || "Factor",
                    levels: Array.isArray(factor.levels) ? factor.levels.slice() : [],
                    type: factor.type === "w" ? "w" : "b",
                };
            })
            .filter(function (factor) {
                return factor.levels.length >= 2;
            });
    }

    function parseStudyDesign(studyDesignString, labels) {
        const designTokens = String(studyDesignString || "")
            .split("*")
            .map(function (token) {
                return token.trim();
            })
            .filter(Boolean);
        const parsedFactors = [];
        let labelIndex = 0;

        for (let tokenIndex = 0; tokenIndex < designTokens.length; tokenIndex++) {
            const match = designTokens[tokenIndex].match(/^(\d+)([bw])$/i);

            if (!match) {
                continue;
            }

            const levelCount = parseInt(match[1], 10);
            const factorLabel = labels && labels[labelIndex] ? labels[labelIndex] : "Factor " + (tokenIndex + 1);
            labelIndex++;
            const levelLabels = [];

            for (let levelIndex = 0; levelIndex < levelCount; levelIndex++) {
                levelLabels.push(labels && labels[labelIndex] ? labels[labelIndex] : "Level " + (levelIndex + 1));
                labelIndex++;
            }

            parsedFactors.push({
                name: factorLabel,
                levels: levelLabels,
                type: match[2].toLowerCase(),
            });
        }

        return normalizeFactors(parsedFactors);
    }

    function getBetweenFactors(factors) {
        return factors.filter(function (factor) {
            return factor.type === "b";
        });
    }

    function getWithinFactors(factors) {
        return factors.filter(function (factor) {
            return factor.type === "w";
        });
    }

    function getBetweenCellCount(factors) {
        const betweenFactors = getBetweenFactors(factors);

        if (!betweenFactors.length) {
            return 1;
        }

        return product(
            betweenFactors.map(function (factor) {
                return factor.levels.length;
            }),
        );
    }

    function getTotalCellCount(factors) {
        if (!factors.length) {
            return 1;
        }

        return product(
            factors.map(function (factor) {
                return factor.levels.length;
            }),
        );
    }

    function dToF(dValue) {
        return Math.abs(Number(dValue) || 0) / 2;
    }

    function fToD(fValue) {
        return Math.abs(Number(fValue) || 0) * 2;
    }

    function fToPartialEtaSquared(fValue) {
        const safeF = Math.abs(Number(fValue) || 0);
        const fSquared = safeF * safeF;
        return fSquared / (1 + fSquared);
    }

    function partialEtaSquaredToF(etaValue) {
        const safeEta = clamp(Number(etaValue) || 0, 0, 0.999999);

        if (safeEta <= 0) {
            return 0;
        }

        return Math.sqrt(safeEta / (1 - safeEta));
    }

    function dToPartialEtaSquared(dValue) {
        return fToPartialEtaSquared(dToF(dValue));
    }

    function partialEtaSquaredToD(etaValue) {
        return fToD(partialEtaSquaredToF(etaValue));
    }

    function logGamma(value) {
        const coefficients = [
            676.5203681218851,
            -1259.1392167224028,
            771.3234287776531,
            -176.6150291621406,
            12.507343278686905,
            -0.13857109526572012,
            9.984369578019572e-6,
            1.5056327351493116e-7,
        ];

        if (value < 0.5) {
            return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
        }

        let accumulator = 0.9999999999998099;
        const adjustedValue = value - 1;

        for (let index = 0; index < coefficients.length; index++) {
            accumulator += coefficients[index] / (adjustedValue + index + 1);
        }

        const seriesValue = adjustedValue + coefficients.length - 0.5;

        return (
            0.9189385332046727 +
            (adjustedValue + 0.5) * Math.log(seriesValue) -
            seriesValue +
            Math.log(accumulator)
        );
    }

    function betaContinuedFraction(a, b, x) {
        const maxIterations = 200;
        const epsilon = 3e-14;
        const fpmin = 1e-300;
        let qab = a + b;
        let qap = a + 1;
        let qam = a - 1;
        let c = 1;
        let d = 1 - (qab * x) / qap;

        if (Math.abs(d) < fpmin) {
            d = fpmin;
        }

        d = 1 / d;
        let h = d;

        for (let iteration = 1; iteration <= maxIterations; iteration++) {
            let m2 = 2 * iteration;
            let aa = (iteration * (b - iteration) * x) / ((qam + m2) * (a + m2));

            d = 1 + aa * d;
            if (Math.abs(d) < fpmin) {
                d = fpmin;
            }
            c = 1 + aa / c;
            if (Math.abs(c) < fpmin) {
                c = fpmin;
            }
            d = 1 / d;
            h *= d * c;

            aa = (-(a + iteration) * (qab + iteration) * x) / ((a + m2) * (qap + m2));
            d = 1 + aa * d;
            if (Math.abs(d) < fpmin) {
                d = fpmin;
            }
            c = 1 + aa / c;
            if (Math.abs(c) < fpmin) {
                c = fpmin;
            }
            d = 1 / d;
            const delta = d * c;
            h *= delta;

            if (Math.abs(delta - 1) < epsilon) {
                break;
            }
        }

        return h;
    }

    function regularizedIncompleteBeta(x, a, b) {
        if (x <= 0) {
            return 0;
        }

        if (x >= 1) {
            return 1;
        }

        const logBetaFactor =
            logGamma(a + b) -
            logGamma(a) -
            logGamma(b) +
            a * Math.log(x) +
            b * Math.log(1 - x);
        const betaFactor = Math.exp(logBetaFactor);

        if (x < (a + 1) / (a + b + 2)) {
            return (betaFactor * betaContinuedFraction(a, b, x)) / a;
        }

        return 1 - (betaFactor * betaContinuedFraction(b, a, 1 - x)) / b;
    }

    function fCdf(value, df1, df2) {
        if (!isFinite(value) || value <= 0) {
            return 0;
        }

        const ratio = (df1 * value) / (df1 * value + df2);
        return regularizedIncompleteBeta(clamp(ratio, 0, 1), df1 / 2, df2 / 2);
    }

    function invertFCdf(probability, df1, df2) {
        const cacheKey = [roundTo(probability, 8), df1, df2].join("|");

        if (criticalFCache.has(cacheKey)) {
            return criticalFCache.get(cacheKey);
        }

        let lower = 0;
        let upper = 1;

        while (fCdf(upper, df1, df2) < probability && upper < 1e7) {
            upper *= 2;
        }

        for (let iteration = 0; iteration < 80; iteration++) {
            const middle = (lower + upper) / 2;

            if (fCdf(middle, df1, df2) < probability) {
                lower = middle;
            } else {
                upper = middle;
            }
        }

        const result = (lower + upper) / 2;
        criticalFCache.set(cacheKey, result);
        return result;
    }

    function noncentralFCdf(xValue, df1, df2, noncentrality) {
        if (noncentrality <= Number.EPSILON) {
            return fCdf(xValue, df1, df2);
        }

        const lambda = noncentrality / 2;
        const ratio = clamp((df1 * xValue) / (df1 * xValue + df2), 0, 1);
        let poissonWeight = Math.exp(-lambda);
        let cumulative = 0;

        for (let index = 0; index < 220; index++) {
            cumulative += poissonWeight * regularizedIncompleteBeta(ratio, df1 / 2 + index, df2 / 2);
            poissonWeight *= lambda / (index + 1);

            if (poissonWeight < 1e-12) {
                break;
            }
        }

        return clamp(cumulative, 0, 1);
    }

    function computeFPower(df1, df2, lambda, alpha) {
        const criticalValue = invertFCdf(1 - alpha, df1, df2);
        const power = 1 - noncentralFCdf(criticalValue, df1, df2, lambda);

        return {
            criticalValue: criticalValue,
            power: clamp(power, 0, 1),
        };
    }

    function buildEffectDefinitions(factors) {
        return powerSet(
            factors.map(function (factor, index) {
                return {
                    index: index,
                    factor: factor,
                };
            }),
        ).map(function (entries) {
            const effectFactors = entries.map(function (entry) {
                return entry.factor;
            });
            const withinFactors = effectFactors.filter(function (factor) {
                return factor.type === "w";
            });
            const betweenFactors = effectFactors.filter(function (factor) {
                return factor.type === "b";
            });

            return {
                indices: entries.map(function (entry) {
                    return entry.index;
                }),
                factors: effectFactors,
                withinFactors: withinFactors,
                betweenFactors: betweenFactors,
                hasWithin: withinFactors.length > 0,
                hasBetween: betweenFactors.length > 0,
                df1: effectFactors.reduce(function (total, factor) {
                    return total * (factor.levels.length - 1);
                }, 1),
                repeatedMeasureCells: withinFactors.length
                    ? product(
                          withinFactors.map(function (factor) {
                              return factor.levels.length;
                          }),
                      )
                    : 1,
                label: effectFactors
                    .map(function (factor) {
                        return factor.name;
                    })
                    .join(" × "),
            };
        });
    }

    function getBetweenEffectWeight(betweenCells) {
        const safeBetweenCells = Math.max(2, Number(betweenCells) || 2);
        return Math.max(
            0.5,
            BETWEEN_WEIGHT_COEFFICIENTS.intercept +
                BETWEEN_WEIGHT_COEFFICIENTS.linear * safeBetweenCells +
                BETWEEN_WEIGHT_COEFFICIENTS.quadratic * safeBetweenCells * safeBetweenCells,
        );
    }

    function getAnovaLambdaWeight(effect, factors, withinCorrelation) {
        const modelHasWithin = getWithinFactors(factors).length > 0;
        const modelHasBetween = getBetweenFactors(factors).length > 0;
        const betweenCells = getBetweenCellCount(factors);

        if (!modelHasWithin || !effect.hasWithin) {
            return getBetweenEffectWeight(betweenCells);
        }

        if (!modelHasBetween) {
            return effect.repeatedMeasureCells / Math.max(1 - withinCorrelation, 0.05);
        }

        if (effect.hasBetween) {
            return effect.repeatedMeasureCells / Math.max(1 - withinCorrelation, 0.05);
        }

        return effect.repeatedMeasureCells / Math.max(1 - withinCorrelation, 0.05);
    }

    function normalizePositiveNumber(value, fallback) {
        const normalized = Number(value);

        if (!isFinite(normalized) || normalized <= 0) {
            return fallback;
        }

        return normalized;
    }

    function normalizeRepeatedMeasuresWithinBetweenInteractionOptions(options) {
        return {
            effectSizeF: Math.max(0, Number(options.effectSizeF) || 0),
            alpha: clamp(Number(options.alpha) || DEFAULT_ALPHA, 1e-9, 0.999999999),
            targetPower: clamp(Number(options.targetPower) || DEFAULT_TARGET_POWER, 1e-9, 0.999999999),
            numberOfGroups: Math.max(2, parseInt(options.numberOfGroups, 10) || 2),
            numberOfMeasurements: Math.max(2, parseInt(options.numberOfMeasurements, 10) || 2),
            corrAmongRepMeasures: clamp(Number(options.corrAmongRepMeasures) || DEFAULT_WITHIN_CORRELATION, -0.999999, 0.999999),
            epsilon: normalizePositiveNumber(options.epsilon, 1),
        };
    }

    function alignTotalSampleSizeToGroups(totalSampleSize, numberOfGroups) {
        const groups = Math.max(2, parseInt(numberOfGroups, 10) || 2);
        const minimumSampleSize = groups * 2;
        const requestedSampleSize = Math.max(minimumSampleSize, parseInt(totalSampleSize, 10) || minimumSampleSize);

        return Math.ceil(requestedSampleSize / groups) * groups;
    }

    function computeRepeatedMeasuresWithinBetweenInteractionPower(options) {
        const normalized = normalizeRepeatedMeasuresWithinBetweenInteractionOptions(options);
        const totalSampleSize = alignTotalSampleSizeToGroups(options.totalSampleSize, normalized.numberOfGroups);
        const numeratorDf = (normalized.numberOfGroups - 1) * (normalized.numberOfMeasurements - 1) * normalized.epsilon;
        const denominatorDf = (totalSampleSize - normalized.numberOfGroups) * (normalized.numberOfMeasurements - 1) * normalized.epsilon;
        const lambda =
            normalized.effectSizeF *
            normalized.effectSizeF *
            totalSampleSize *
            ((normalized.numberOfMeasurements * normalized.epsilon) / Math.max(1 - normalized.corrAmongRepMeasures, 1e-9));
        const criticalF = invertFCdf(1 - normalized.alpha, numeratorDf, denominatorDf);
        const actualPower = clamp(1 - noncentralFCdf(criticalF, numeratorDf, denominatorDf, lambda), 0, 1);

        return {
            sampleSize: totalSampleSize,
            totalSampleSize: totalSampleSize,
            lambda: lambda,
            criticalF: criticalF,
            criticalValue: criticalF,
            numeratorDf: numeratorDf,
            denominatorDf: denominatorDf,
            df1: numeratorDf,
            df2: denominatorDf,
            actualPower: actualPower,
            power: actualPower,
        };
    }

    function estimatePowerForRepeatedMeasuresWithinBetweenInteraction(options) {
        return computeRepeatedMeasuresWithinBetweenInteractionPower(options);
    }

    function estimateSampleSizeForRepeatedMeasuresWithinBetweenInteraction(options) {
        const normalized = normalizeRepeatedMeasuresWithinBetweenInteractionOptions(options);
        let sampleSize = normalized.numberOfGroups * 2;
        let result = computeRepeatedMeasuresWithinBetweenInteractionPower(
            Object.assign({}, normalized, {
                totalSampleSize: sampleSize,
            }),
        );
        let iterations = 0;
        const maxIterations = Math.ceil(MAX_SEARCH_PARTICIPANTS / normalized.numberOfGroups);

        while (result.actualPower < normalized.targetPower && sampleSize < MAX_SEARCH_PARTICIPANTS && iterations < maxIterations) {
            sampleSize += normalized.numberOfGroups;
            result = computeRepeatedMeasuresWithinBetweenInteractionPower(
                Object.assign({}, normalized, {
                    totalSampleSize: sampleSize,
                }),
            );
            iterations++;
        }

        return {
            sampleSize: result.sampleSize,
            totalSampleSize: result.totalSampleSize,
            lambda: result.lambda,
            criticalF: result.criticalF,
            criticalValue: result.criticalValue,
            numeratorDf: result.numeratorDf,
            denominatorDf: result.denominatorDf,
            df1: result.df1,
            df2: result.df2,
            actualPower: result.actualPower,
            power: result.actualPower,
        };
    }

    function hasSingleBetweenAndWithinFactor(factors) {
        return getBetweenFactors(factors).length === 1 && getWithinFactors(factors).length === 1 && factors.length === 2;
    }

    function computeAnovaRowsAtSampleSize(options, totalParticipants) {
        const factors = normalizeFactors(options.factors);
        const effectSizeF = Math.max(0, Number(options.effectSizeF) || 0);
        const alpha = Number(options.alpha) || DEFAULT_ALPHA;
        const withinCorrelation = clamp(Number(options.withinCorrelation) || DEFAULT_WITHIN_CORRELATION, -0.999999, 0.999999);
        const epsilon = normalizePositiveNumber(options.epsilon, 1);
        const betweenFactors = getBetweenFactors(factors);
        const withinFactors = getWithinFactors(factors);
        const betweenCells = getBetweenCellCount(factors);
        const alignedParticipants = hasSingleBetweenAndWithinFactor(factors)
            ? alignTotalSampleSizeToGroups(totalParticipants, betweenCells)
            : Math.max(2, parseInt(totalParticipants, 10) || 2);
        const subjectDfBase = Math.max(1, alignedParticipants - betweenCells);

        return buildEffectDefinitions(factors).map(function (effect) {
            if (hasSingleBetweenAndWithinFactor(factors) && effect.hasBetween && effect.hasWithin) {
                const mixedInteraction = computeRepeatedMeasuresWithinBetweenInteractionPower({
                    effectSizeF: effectSizeF,
                    alpha: alpha,
                    totalSampleSize: alignedParticipants,
                    numberOfGroups: betweenFactors[0].levels.length,
                    numberOfMeasurements: withinFactors[0].levels.length,
                    corrAmongRepMeasures: withinCorrelation,
                    epsilon: epsilon,
                });

                return {
                    label: effect.label,
                    effectType: "mixed interaction",
                    df1: mixedInteraction.df1,
                    df2: mixedInteraction.df2,
                    lambda: mixedInteraction.lambda,
                    criticalValue: mixedInteraction.criticalValue,
                    power: mixedInteraction.actualPower,
                    cohenF: effectSizeF,
                    partialEtaSquared: fToPartialEtaSquared(effectSizeF),
                };
            }

            const denominatorDf = effect.hasWithin ? Math.max(1, subjectDfBase * effect.df1 * epsilon) : subjectDfBase;
            const lambdaWeight = getAnovaLambdaWeight(effect, factors, withinCorrelation);
            const lambda = Math.max(0, effectSizeF * effectSizeF * alignedParticipants * lambdaWeight);
            const powerResult = computeFPower(effect.df1, denominatorDf, lambda, alpha);

            return {
                label: effect.label,
                effectType: effect.hasWithin && effect.hasBetween ? "mixed interaction" : effect.hasWithin ? "within" : "between",
                df1: effect.df1,
                df2: denominatorDf,
                lambda: lambda,
                criticalValue: powerResult.criticalValue,
                power: powerResult.power,
                cohenF: effectSizeF,
                partialEtaSquared: fToPartialEtaSquared(effectSizeF),
            };
        });
    }

    function getControllingEffect(effectRows) {
        if (!effectRows.length) {
            return null;
        }

        return effectRows.reduce(function (currentMinimum, row) {
            if (!currentMinimum || row.power < currentMinimum.power) {
                return row;
            }

            return currentMinimum;
        }, null);
    }

    function searchMinimumSampleSize(findPowerAtSampleSize, minimumN, targetPower, stepSize) {
        const effectiveStepSize = Math.max(1, parseInt(stepSize, 10) || 1);
        let upperBound = Math.max(effectiveStepSize, minimumN);
        let upperResult = findPowerAtSampleSize(upperBound);
        let iterations = 0;

        while (upperResult.controllingPower < targetPower && upperBound < MAX_SEARCH_PARTICIPANTS && iterations < MAX_SEARCH_ITERATIONS) {
            const nextUpperBound = Math.min(MAX_SEARCH_PARTICIPANTS, upperBound * 2);

            if (nextUpperBound <= upperBound) {
                break;
            }

            upperBound = nextUpperBound;
            upperResult = findPowerAtSampleSize(upperBound);
            iterations++;
        }

        if (upperResult.controllingPower < targetPower) {
            return {
                minimumN: upperBound,
                result: upperResult,
            };
        }

        let bestN = upperBound;
        let left = minimumN;
        let right = upperBound;

        while (left <= right) {
            const middle = Math.max(effectiveStepSize, Math.floor((left + right) / (2 * effectiveStepSize)) * effectiveStepSize);
            const middleResult = findPowerAtSampleSize(middle);

            if (middleResult.controllingPower >= targetPower) {
                bestN = middle;
                right = middle - effectiveStepSize;
            } else {
                left = middle + effectiveStepSize;
            }
        }

        return {
            minimumN: bestN,
            result: findPowerAtSampleSize(bestN),
        };
    }

    function buildCurvePoints(findPowerAtSampleSize, minimumN, stepSize) {
        const points = [];
        const effectiveStepSize = Math.max(1, parseInt(stepSize, 10) || 1);
        const maxN = Math.min(MAX_SEARCH_PARTICIPANTS, Math.max(minimumN + 24, Math.ceil(minimumN * 1.8)));
        const step = Math.max(effectiveStepSize, Math.ceil((maxN - effectiveStepSize) / Math.max(1, MAX_CURVE_POINTS - 2)));

        for (let sampleSize = effectiveStepSize; sampleSize <= maxN; sampleSize += step) {
            points.push({
                totalParticipants: sampleSize,
                rows: findPowerAtSampleSize(sampleSize).rows,
            });
        }

        if (!points.length || points[points.length - 1].totalParticipants !== minimumN) {
            points.push({
                totalParticipants: minimumN,
                rows: findPowerAtSampleSize(minimumN).rows,
            });
        }

        return points.sort(function (left, right) {
            return left.totalParticipants - right.totalParticipants;
        });
    }

    function estimateAnovaModel(options) {
        const factors = normalizeFactors(options.factors);
        const includeCurvePoints = options.includeCurvePoints !== false;

        if (!factors.length) {
            return {
                effectRows: [],
                curvePoints: [],
                minimumN: 0,
                controllingEffect: null,
            };
        }

        const targetPower = clamp(Number(options.targetPower) || DEFAULT_TARGET_POWER, 0.01, 0.999);
        const groupedMixedDesign = hasSingleBetweenAndWithinFactor(factors);
        const stepSize = groupedMixedDesign ? getBetweenCellCount(factors) : 1;
        const minimumNFloor = groupedMixedDesign ? stepSize * 2 : Math.max(4, getBetweenCellCount(factors) + 2);
        const findPowerAtSampleSize = function (sampleSize) {
            const alignedSampleSize = groupedMixedDesign ? alignTotalSampleSizeToGroups(sampleSize, stepSize) : sampleSize;
            const rows = computeAnovaRowsAtSampleSize(options, alignedSampleSize);
            const controllingEffect = getControllingEffect(rows);

            return {
                rows: rows,
                controllingEffect: controllingEffect,
                controllingPower: controllingEffect ? controllingEffect.power : 0,
            };
        };
        const searchResult = searchMinimumSampleSize(findPowerAtSampleSize, minimumNFloor, targetPower, stepSize);

        return {
            sampleSize: groupedMixedDesign ? alignTotalSampleSizeToGroups(searchResult.minimumN, stepSize) : searchResult.minimumN,
            minimumN: groupedMixedDesign ? alignTotalSampleSizeToGroups(searchResult.minimumN, stepSize) : searchResult.minimumN,
            targetPower: targetPower,
            effectRows: searchResult.result.rows,
            controllingEffect: searchResult.result.controllingEffect,
            curvePoints: includeCurvePoints
                ? buildCurvePoints(
                      findPowerAtSampleSize,
                      groupedMixedDesign ? alignTotalSampleSizeToGroups(searchResult.minimumN, stepSize) : searchResult.minimumN,
                      stepSize,
                  )
                : [],
        };
    }

    function estimateAnovaPower(options) {
        const totalParticipants = Math.max(2, parseInt(options.totalParticipants, 10) || 2);
        const rows = computeAnovaRowsAtSampleSize(options, totalParticipants);

        return {
            sampleSize: totalParticipants,
            rows: rows.map(function (row) {
                return {
                    _row: row.label,
                    power: roundTo(row.power * 100, 1),
                    partial_eta_squared: roundTo(row.partialEtaSquared, 3),
                    cohen_f: roundTo(row.cohenF, 3),
                    df1: row.df1,
                    df2: row.df2,
                };
            }),
        };
    }

    function estimateAnovaEffectSizes(options) {
        const effectSizeF = Math.max(0, Number(options.effectSizeF) || 0);
        const rows = buildEffectDefinitions(normalizeFactors(options.factors)).map(function (effect) {
            return {
                label: effect.label,
                cohenF: effectSizeF,
                partialEtaSquared: fToPartialEtaSquared(effectSizeF),
            };
        });

        return {
            representative: rows.length
                ? {
                      label: rows[0].label,
                      cohenF: effectSizeF,
                      partialEtaSquared: fToPartialEtaSquared(effectSizeF),
                  }
                : null,
            rows: rows,
        };
    }

    function estimateSampleSizeForAnova(options) {
        return estimateAnovaModel(
            Object.assign({}, options, {
                includeCurvePoints: false,
            }),
        );
    }

    function computeIndependentTTest(totalParticipants, cohenD, alpha) {
        const df2 = Math.max(1, totalParticipants - 2);
        const cohenF = dToF(cohenD);
        const lambda = totalParticipants * cohenF * cohenF;
        const powerResult = computeFPower(1, df2, lambda, alpha);

        return {
            sampleSize: totalParticipants,
            power: powerResult.power,
            lambda: lambda,
            criticalValue: powerResult.criticalValue,
            df1: 1,
            df2: df2,
            cohenD: Math.abs(cohenD),
            cohenF: cohenF,
            partialEtaSquared: dToPartialEtaSquared(cohenD),
        };
    }

    function computePairedTTest(totalParticipants, cohenD, withinCorrelation, alpha) {
        const df2 = Math.max(1, totalParticipants - 1);
        const dz = Math.abs(cohenD) / Math.sqrt(Math.max(2 * (1 - withinCorrelation), 0.05));
        const lambda = totalParticipants * dz * dz;
        const powerResult = computeFPower(1, df2, lambda, alpha);

        return {
            sampleSize: totalParticipants,
            power: powerResult.power,
            lambda: lambda,
            criticalValue: powerResult.criticalValue,
            df1: 1,
            df2: df2,
            cohenD: Math.abs(cohenD),
            cohenDz: dz,
            cohenF: Math.sqrt(lambda / totalParticipants),
            partialEtaSquared: lambda / (lambda + df2),
        };
    }

    function estimateTTestModel(options) {
        const paired = Boolean(options.paired);
        const includeCurvePoints = options.includeCurvePoints !== false;
        const alpha = Number(options.alpha) || DEFAULT_ALPHA;
        const targetPower = clamp(Number(options.targetPower) || DEFAULT_TARGET_POWER, 0.01, 0.999);
        const withinCorrelation = clamp(Number(options.withinCorrelation) || DEFAULT_WITHIN_CORRELATION, 0, 0.95);
        const cohenD = Math.abs(Number(options.cohenD) || 0);
        const evaluate = function (sampleSize) {
            return paired ? computePairedTTest(sampleSize, cohenD, withinCorrelation, alpha) : computeIndependentTTest(sampleSize, cohenD, alpha);
        };
        const minimumNFloor = paired ? 4 : 6;
        const searchResult = searchMinimumSampleSize(
            function (sampleSize) {
                const result = evaluate(sampleSize);

                return {
                    rows: [result],
                    controllingEffect: result,
                    controllingPower: result.power,
                };
            },
            minimumNFloor,
            targetPower,
            1,
        );

        return {
            sampleSize: searchResult.minimumN,
            minimumN: searchResult.minimumN,
            targetPower: targetPower,
            paired: paired,
            effectRow: searchResult.result.controllingEffect,
            curvePoints: includeCurvePoints
                ? buildCurvePoints(
                      function (sampleSize) {
                          return {
                              rows: [evaluate(sampleSize)],
                          };
                      },
                      searchResult.minimumN,
                      1,
                  )
                : [],
        };
    }

    function estimateTTestPower(options) {
        const paired = Boolean(options.paired);
        const alpha = Number(options.alpha) || DEFAULT_ALPHA;
        const withinCorrelation = clamp(Number(options.withinCorrelation) || DEFAULT_WITHIN_CORRELATION, 0, 0.95);
        const cohenD = Math.abs(Number(options.cohenD) || 0);
        const participants = Math.max(paired ? 4 : 6, parseInt(options.participants, 10) || (paired ? 4 : 6));

        return paired ? computePairedTTest(participants, cohenD, withinCorrelation, alpha) : computeIndependentTTest(participants, cohenD, alpha);
    }

    function estimateRegressionModelStatistics(predictors, participants, effectSizeFSquared, alpha) {
        const numeratorDf = Math.max(1, predictors);
        const denominatorDf = Math.max(1, participants - predictors - 1);
        const lambda = Math.max(0, Number(effectSizeFSquared) || 0) * participants;
        const rSquared = effectSizeFSquared <= 0 ? 0 : effectSizeFSquared / (1 + effectSizeFSquared);
        const powerResult = computeFPower(numeratorDf, denominatorDf, lambda, alpha);

        return {
            numeratorDf: numeratorDf,
            denominatorDf: denominatorDf,
            lambda: lambda,
            criticalValue: powerResult.criticalValue,
            power: powerResult.power,
            fSquared: effectSizeFSquared,
            rSquared: rSquared,
        };
    }

    function estimateRegressionPower(options) {
        const predictors = Math.max(1, parseInt(options.predictors, 10) || 1);
        const participants = Math.max(predictors + 3, parseInt(options.participants, 10) || predictors + 3);
        const alpha = Number(options.alpha) || DEFAULT_ALPHA;
        const effectSizeFSquared = Math.max(0, Number(options.effectSizeFSquared) || 0);
        const result = estimateRegressionModelStatistics(predictors, participants, effectSizeFSquared, alpha);

        return {
            predictors: predictors,
            participants: participants,
            fSquared: result.fSquared,
            alpha: alpha,
            power: result.power,
            tableRows: [
                { label: "Predictors", value: predictors },
                { label: "Numerator df (u)", value: result.numeratorDf },
                { label: "Denominator df (v)", value: result.denominatorDf },
                { label: "Effect size (f^2)", value: roundTo(result.fSquared, 3) },
                { label: "Expected R^2", value: roundTo(result.rSquared, 3) },
                { label: "Lambda", value: roundTo(result.lambda, 3) },
                { label: "Power", value: roundTo(result.power * 100, 1) + "%" },
            ],
        };
    }

    function estimateSampleSizeForRegression(options) {
        const predictors = Math.max(1, parseInt(options.predictors, 10) || 1);
        const includeCurvePoints = options.includeCurvePoints !== false;
        const targetPower = clamp(Number(options.targetPower) || DEFAULT_TARGET_POWER, 0.01, 0.999);
        const alpha = Number(options.alpha) || DEFAULT_ALPHA;
        const effectSizeFSquared = Math.max(0, Number(options.effectSizeFSquared) || 0);
        const minimumNFloor = Math.max(predictors + 3, 8);
        const searchResult = searchMinimumSampleSize(
            function (sampleSize) {
                const result = estimateRegressionModelStatistics(predictors, sampleSize, effectSizeFSquared, alpha);

                return {
                    rows: [result],
                    controllingEffect: result,
                    controllingPower: result.power,
                };
            },
            minimumNFloor,
            targetPower,
            1,
        );

        return {
            sampleSize: searchResult.minimumN,
            minimumN: searchResult.minimumN,
            targetPower: targetPower,
            effectRow: searchResult.result.controllingEffect,
            curvePoints: includeCurvePoints
                ? buildCurvePoints(
                      function (sampleSize) {
                          return {
                              rows: [estimateRegressionModelStatistics(predictors, sampleSize, effectSizeFSquared, alpha)],
                          };
                      },
                      searchResult.minimumN,
                      1,
                  )
                : [],
            powerResult: estimateRegressionPower({
                predictors: predictors,
                participants: searchResult.minimumN,
                effectSizeFSquared: effectSizeFSquared,
                alpha: alpha,
            }),
        };
    }

    const exportedApi = {
        parseStudyDesign: parseStudyDesign,
        dToF: dToF,
        fToD: fToD,
        fToPartialEtaSquared: fToPartialEtaSquared,
        partialEtaSquaredToF: partialEtaSquaredToF,
        dToPartialEtaSquared: dToPartialEtaSquared,
        partialEtaSquaredToD: partialEtaSquaredToD,
        fCdf: fCdf,
        invertFCdf: invertFCdf,
        noncentralFCdf: noncentralFCdf,
        estimateAnovaEffectSizes: estimateAnovaEffectSizes,
        estimateAnovaPower: estimateAnovaPower,
        estimateAnovaModel: estimateAnovaModel,
        estimateSampleSizeForAnova: estimateSampleSizeForAnova,
        estimatePowerForRepeatedMeasuresWithinBetweenInteraction: estimatePowerForRepeatedMeasuresWithinBetweenInteraction,
        estimateSampleSizeForRepeatedMeasuresWithinBetweenInteraction: estimateSampleSizeForRepeatedMeasuresWithinBetweenInteraction,
        estimateTTestModel: estimateTTestModel,
        estimateTTestPower: estimateTTestPower,
        estimateRegressionPower: estimateRegressionPower,
        estimateSampleSizeForRegression: estimateSampleSizeForRegression,
        getTotalCellCount: getTotalCellCount,
        getBetweenCellCount: getBetweenCellCount,
    };

    global.StudyPowerEngine = exportedApi;
    global.PowerEngine = exportedApi;
})(window);
