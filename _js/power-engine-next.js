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
    const MIXED_INTERACTION_WEIGHT_COEFFICIENTS = {
        intercept: 0.1513622,
        linear: 0.673213,
        quadratic: -0.0393958,
    };
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

    function fCdf(value, df1, df2) {
        if (!isFinite(value) || value <= 0) {
            return 0;
        }

        const ratio = (df1 * value) / (df1 * value + df2);
        return stats.regularisedBeta(clamp(ratio, 0, 1), df1 / 2, df2 / 2);
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
        let poissonWeight = Math.exp(-lambda);
        let cumulative = 0;

        for (let index = 0; index < 220; index++) {
            cumulative += poissonWeight * fCdf(xValue, df1 + 2 * index, df2);
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

    function getMixedInteractionWeight(repeatedMeasureCells, withinCorrelation) {
        const safeCells = Math.max(2, Number(repeatedMeasureCells) || 2);
        const baseWeight =
            MIXED_INTERACTION_WEIGHT_COEFFICIENTS.intercept +
            MIXED_INTERACTION_WEIGHT_COEFFICIENTS.linear * safeCells +
            MIXED_INTERACTION_WEIGHT_COEFFICIENTS.quadratic * safeCells * safeCells;

        return Math.max(0.75, baseWeight) * (0.5 / Math.max(1 - withinCorrelation, 0.05));
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
            return getMixedInteractionWeight(effect.repeatedMeasureCells, withinCorrelation);
        }

        return effect.repeatedMeasureCells / Math.max(1 - withinCorrelation, 0.05);
    }

    function computeAnovaRowsAtSampleSize(options, totalParticipants) {
        const factors = normalizeFactors(options.factors);
        const effectSizeF = Math.max(0, Number(options.effectSizeF) || 0);
        const alpha = Number(options.alpha) || DEFAULT_ALPHA;
        const withinCorrelation = clamp(Number(options.withinCorrelation) || DEFAULT_WITHIN_CORRELATION, 0, 0.95);
        const betweenCells = getBetweenCellCount(factors);
        const subjectDfBase = Math.max(1, totalParticipants - betweenCells);

        return buildEffectDefinitions(factors).map(function (effect) {
            const denominatorDf = effect.hasWithin ? Math.max(1, subjectDfBase * effect.df1) : subjectDfBase;
            const lambdaWeight = getAnovaLambdaWeight(effect, factors, withinCorrelation);
            const lambda = Math.max(0, effectSizeF * effectSizeF * totalParticipants * lambdaWeight);
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

    function searchMinimumSampleSize(findPowerAtSampleSize, minimumN, targetPower) {
        let upperBound = Math.max(2, minimumN);
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
            const middle = Math.floor((left + right) / 2);
            const middleResult = findPowerAtSampleSize(middle);

            if (middleResult.controllingPower >= targetPower) {
                bestN = middle;
                right = middle - 1;
            } else {
                left = middle + 1;
            }
        }

        return {
            minimumN: bestN,
            result: findPowerAtSampleSize(bestN),
        };
    }

    function buildCurvePoints(findPowerAtSampleSize, minimumN) {
        const points = [];
        const maxN = Math.min(MAX_SEARCH_PARTICIPANTS, Math.max(minimumN + 24, Math.ceil(minimumN * 1.8)));
        const step = Math.max(1, Math.ceil((maxN - 2) / Math.max(1, MAX_CURVE_POINTS - 2)));

        for (let sampleSize = 2; sampleSize <= maxN; sampleSize += step) {
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
        const minimumNFloor = Math.max(4, getBetweenCellCount(factors) + 2);
        const findPowerAtSampleSize = function (sampleSize) {
            const rows = computeAnovaRowsAtSampleSize(options, sampleSize);
            const controllingEffect = getControllingEffect(rows);

            return {
                rows: rows,
                controllingEffect: controllingEffect,
                controllingPower: controllingEffect ? controllingEffect.power : 0,
            };
        };
        const searchResult = searchMinimumSampleSize(findPowerAtSampleSize, minimumNFloor, targetPower);

        return {
            sampleSize: searchResult.minimumN,
            minimumN: searchResult.minimumN,
            targetPower: targetPower,
            effectRows: searchResult.result.rows,
            controllingEffect: searchResult.result.controllingEffect,
            curvePoints: includeCurvePoints ? buildCurvePoints(findPowerAtSampleSize, searchResult.minimumN) : [],
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

    global.StudyPowerEngine = {
        parseStudyDesign: parseStudyDesign,
        dToF: dToF,
        fToD: fToD,
        fToPartialEtaSquared: fToPartialEtaSquared,
        partialEtaSquaredToF: partialEtaSquaredToF,
        dToPartialEtaSquared: dToPartialEtaSquared,
        partialEtaSquaredToD: partialEtaSquaredToD,
        estimateAnovaEffectSizes: estimateAnovaEffectSizes,
        estimateAnovaPower: estimateAnovaPower,
        estimateAnovaModel: estimateAnovaModel,
        estimateSampleSizeForAnova: estimateSampleSizeForAnova,
        estimateTTestModel: estimateTTestModel,
        estimateTTestPower: estimateTTestPower,
        estimateRegressionPower: estimateRegressionPower,
        estimateSampleSizeForRegression: estimateSampleSizeForRegression,
        getTotalCellCount: getTotalCellCount,
        getBetweenCellCount: getBetweenCellCount,
    };
})(window);
