(() => {
'use strict';
	let debug = false;
	let IVs = 0;
	let DVs = 0;
	let manualSampleSizeUpdate = false;
	let serverANOVARequestRunning = false;
	let serverRegressionRequestRunning = false;
	let serverRequestRunning = false;
	let studyDesign;
	let sampleSize = 0;
	let sampleSizeReady = false;
	let lastAnovaPowerResult = null;
	let lastRegressionPowerResult = null;
	let lastTTestPowerResult = null;
	let powerChartInstance = null;
	let plannerUpdateSuspended = false;
	let refreshPlanner = function() {};
	const simulations = 24;
	
		// Resets study design to its initial state
		function resetStudyDesign() {
			studyDesign = {
				"IVs": [],
				"DVs": [],
				"MANOVA": false,
				"betweenIVs": [],
				"withinIVs": [],
				"allBetweenLevels": [],
				"allWithinLevels": [],
				"allConditions": [],
				"allCombinations": []
			};    
		}

		function hasStudyDesignInputs() {
			return studyDesign.IVs.length > 0 && studyDesign.DVs.length > 0;
		}

		function updateSectionVisibility() {
			const hasInputs = hasStudyDesignInputs();
			$("#estimationControlsSection").toggle(hasInputs);
			$("#resultsGuidanceSection").toggle(hasInputs && sampleSizeReady);
		}

		function resetSampleSizeProgress() {
			sampleSizeReady = false;
			updateSectionVisibility();
		}

		function markSampleSizeReady() {
			sampleSizeReady = true;
			updateSectionVisibility();
		}

		function getNominalFactors() {
			let factors = [];

			$.each(studyDesign.betweenIVs, function(index) {
				factors.push({
					name: studyDesign.betweenIVs[index].name,
					levels: studyDesign.betweenIVs[index].levels.slice(),
					type: "b"
				});
			});

			$.each(studyDesign.withinIVs, function(index) {
				factors.push({
					name: studyDesign.withinIVs[index].name,
					levels: studyDesign.withinIVs[index].levels.slice(),
					type: "w"
				});
			});

			return factors;
		}

		function hasNominalFactors() {
			return getNominalFactors().length > 0;
		}

		function hasRegressionPredictors() {
			return studyDesign.nonOrdinalIVs && studyDesign.nonOrdinalIVs.length > 0;
		}

		function getCurrentWithinCorrelation() {
			return hasNominalFactors() && studyDesign.withinIVs.length > 0 ? 0.5 : 0;
		}

		function getCurrentPooledSd() {
			return parseFloat($("#varianceInputId").val());
		}

		function getTargetPower() {
			return 0.8;
		}

		function getEffectInputMode() {
			return $("#effectSizeModeId").val() || "means";
		}

		function isTTestScenario() {
			let nominalIVs = studyDesign.IVs.filter(function(iv) {
				return iv.type === "N";
			});
			let betweenCells = studyDesign.betweenConditions && studyDesign.betweenConditions.length ? studyDesign.betweenConditions.length : 1;
			let withinCells = studyDesign.withinConditions && studyDesign.withinConditions.length ? studyDesign.withinConditions.length : 1;
			let totalConditions = Math.max(1, betweenCells * withinCells);
			let onlyBetweenNominal = studyDesign.withinIVs.length === 0 && studyDesign.betweenIVs.length === 1 && studyDesign.betweenIVs[0].levels.length === 2;
			let onlyWithinNominal = studyDesign.betweenIVs.length === 0 && studyDesign.withinIVs.length === 1 && studyDesign.withinIVs[0].levels.length === 2;

			return hasNominalFactors() &&
				studyDesign.nonOrdinalIVs.length === 0 &&
				studyDesign.DVs.length === 1 &&
				nominalIVs.length === 1 &&
				totalConditions === 2 &&
				(onlyBetweenNominal || onlyWithinNominal);
		}

		function getPrimaryAnalysisKind() {
			if (isTTestScenario()) {
				return "ttest";
			}

			if (hasNominalFactors()) {
				return "anova";
			}

			if (hasRegressionPredictors()) {
				return "regression";
			}

			return "none";
		}

		function resolveEffectSizes() {
			const effectMode = getEffectInputMode();
			const meanDelta = parseFloat($("#meanDeltaInputId").val() || "0");
			const pooledSD = Math.max(parseFloat($("#varianceInputId").val() || "0.001"), 0.001);
			const directValue = Math.max(parseFloat($("#effectSizeInputId").val() || "0"), 0);
			let cohensD = 0;
			let cohensF = 0;
			let partialEtaSquared = 0;
			let note = "";

			if (effectMode === "d") {
				cohensD = directValue;
				cohensF = StudyPowerEngine.dToF(cohensD);
				partialEtaSquared = StudyPowerEngine.dToPartialEtaSquared(cohensD);
				note = "Converted from Cohen's d using the two-condition reference mapping.";
			} else if (effectMode === "f") {
				cohensF = directValue;
				partialEtaSquared = StudyPowerEngine.fToPartialEtaSquared(cohensF);
				cohensD = StudyPowerEngine.fToD(cohensF);
				note = "Omnibus ANOVA effect size input.";
			} else if (effectMode === "eta") {
				partialEtaSquared = Math.min(directValue, 0.999);
				cohensF = StudyPowerEngine.partialEtaSquaredToF(partialEtaSquared);
				cohensD = StudyPowerEngine.partialEtaSquaredToD(partialEtaSquared);
				note = "Converted from partial eta squared.";
			} else {
				cohensD = getCohensD(meanDelta, pooledSD);
				cohensF = StudyPowerEngine.dToF(cohensD);
				partialEtaSquared = StudyPowerEngine.fToPartialEtaSquared(cohensF);
				note = "Derived from the current min/max mean difference and pooled SD.";
			}

			return {
				mode: effectMode,
				meanDelta: meanDelta,
				pooledSD: pooledSD,
				cohensD: Math.max(0, cohensD),
				cohensF: Math.max(0, cohensF),
				partialEtaSquared: Math.max(0, partialEtaSquared),
				note: note
			};
		}

		function computeTTestPowerAtSampleSize(participants, cohensD, paired, withinCorrelation) {
			let result = StudyPowerEngine.estimateTTestPower({
				participants: participants,
				cohenD: cohensD,
				paired: paired,
				withinCorrelation: withinCorrelation,
				alpha: 0.05
			});
			result.label = paired ? "Paired t-test" : "Independent t-test";
			return result;
		}

		function normalizeLevelValue(level) {
			return $.trim(String(level || "")).replaceAll(" ", "");
		}

		function deserializeLevels(levelString) {
			return String(levelString || "")
				.split(",")
				.map(function(level) {
					return normalizeLevelValue(level);
				})
				.filter(function(level) {
					return level !== "";
				});
		}

		function serializeLevels(levels) {
			return (levels || []).map(function(level) {
				return normalizeLevelValue(level);
			}).filter(function(level) {
				return level !== "";
			}).join(", ");
		}

		function getCurrentLevelTokens() {
			return deserializeLevels($("input[name='enterLevelsIV']").val());
		}

		function renderLevelTokens() {
			let tokenList = $("#levelsTokenList");
			let levels = getCurrentLevelTokens();

			tokenList.empty();
			levels.forEach(function(level, index) {
				tokenList.append(
					'<span class="level-token">' +
						'<span class="level-token-label">' + level + '</span>' +
						'<button type="button" class="btn btn-sm level-token-remove" data-level-index="' + index + '" aria-label="Remove level ' + level + '">' +
							'<i class="bi bi-x-lg"></i>' +
						'</button>' +
					'</span>'
				);
			});
		}

		function setFieldValidationState(selector, isValid, messageSelector, message) {
			let field = $(selector);
			let feedback = messageSelector ? $(messageSelector) : $();

			field.toggleClass("is-invalid", !isValid);

			if(feedback.length > 0) {
				if(message) {
					feedback.text(message);
				}

				feedback.toggle(!isValid);
			}
		}

		function clearFieldValidationState(selector, messageSelector) {
			let field = $(selector);
			let feedback = messageSelector ? $(messageSelector) : $();

			field.removeClass("is-invalid");

			if(feedback.length > 0) {
				feedback.hide();
			}
		}

		function validateVariableName(value, itemLabel) {
			let trimmedValue = $.trim(String(value || ""));

			if(trimmedValue === "") {
				return itemLabel + " name is required.";
			}

			return "";
		}

		function validateCurrentIVInputs(showErrors) {
			let nameError = validateVariableName($("input[name='nameIV']").val(), "IV");
			let levels = getCurrentLevelTokens();
			let hasDuplicateLevels = levels.some(function(level, index) {
				return levels.findIndex(function(otherLevel) {
					return normalizeLevelValue(otherLevel).toLowerCase() === normalizeLevelValue(level).toLowerCase();
				}) !== index;
			});
			let needsLevels = $("select[name='selectIVType']").val() === "N";
			let levelsError = "";

			if(needsLevels && levels.length < 2) {
				levelsError = "Please add at least two unique levels.";
			} else if(needsLevels && hasDuplicateLevels) {
				levelsError = "Level names must be unique.";
			}

			if(showErrors) {
				setFieldValidationState("input[name='nameIV']", nameError === "", "#ivNameFeedback", nameError || "Please enter a valid IV name.");
				$("#levelsTokenShell").toggleClass("is-invalid", levelsError !== "");
				$("#ivLevelsFeedback").text(levelsError || "Please add at least two unique levels.").toggle(levelsError !== "");
			}

			return nameError === "" && levelsError === "";
		}

		function validateCurrentDVInputs(showErrors) {
			let nameError = validateVariableName($("input[name='nameDV']").val(), "DV");

			if(showErrors) {
				setFieldValidationState("input[name='nameDV']", nameError === "", "#dvNameFeedback", nameError || "Please enter a valid DV name.");
			}

			return nameError === "";
		}

		function setCurrentLevelTokens(levels) {
			$("input[name='enterLevelsIV']").val(serializeLevels(levels));
			renderLevelTokens();
		}

		function addLevelToken(levelValue) {
			let normalizedLevel = normalizeLevelValue(levelValue);
			let levels = getCurrentLevelTokens();

			if(normalizedLevel === "") {
				$("#levelsTokenInput").val("");
				return;
			}

			if(levels.some(function(level) {
				return normalizeLevelValue(level).toLowerCase() === normalizedLevel.toLowerCase();
			})) {
				$("#levelsTokenInput").val("");
				return;
			}

			levels.push(normalizedLevel);
			setCurrentLevelTokens(levels);
			$("#levelsTokenInput").val("");
			clearFieldValidationState("input[name='nameIV']", "#ivNameFeedback");
			$("#levelsTokenShell").removeClass("is-invalid");
			$("#ivLevelsFeedback").hide();
		}

		function syncLevelTokensFromSerializedInput() {
			setCurrentLevelTokens(deserializeLevels($("input[name='enterLevelsIV']").val()));
		}

		function clearLevelTokens() {
			setCurrentLevelTokens([]);
			$("#levelsTokenInput").val("");
			$("#levelsTokenShell").removeClass("is-invalid");
			$("#ivLevelsFeedback").hide();
		}

		function getIVTypeLabel(typeValue) {
			let labels = {
				N: "Nominal",
				O: "Ordinal",
				I: "Interval",
				R: "Ratio"
			};

			return labels[typeValue] || typeValue;
		}

		function escapeHtml(value) {
			return String(value == null ? "" : value)
				.replaceAll("&", "&amp;")
				.replaceAll("<", "&lt;")
				.replaceAll(">", "&gt;")
				.replaceAll('"', "&quot;")
				.replaceAll("'", "&#39;");
		}

		function updateVariableActionState() {
			if(studyDesign.IVs.length > 2) {
				$("#addIV").addClass("disabled");
			} else {
				$("#addIV").removeClass("disabled");
			}

			if(studyDesign.DVs.length > 3) {
				$("#addDV").addClass("disabled");
			} else {
				$("#addDV").removeClass("disabled");
			}
		}

		function buildSelectOptions(options, selectedValue) {
			return options.map(function(option) {
				let isSelected = option.value === selectedValue ? " selected" : "";
				return '<option value="' + escapeHtml(option.value) + '"' + isSelected + '>' + escapeHtml(option.label) + '</option>';
			}).join("");
		}

		function buildSelectionItem(item, listType) {
			let itemId = item.id;
			let isIV = listType === "iv";
			let metadata = [];
			let typeConfigHtml = "";
			let designConfigHtml = "";

			if(isIV) {
				typeConfigHtml = '<div class="selection-field"><label class="selection-field-label">IV type</label><select class="form-select form-select-sm selection-inline-select iv-type-select" data-item-id="' + itemId + '">' +
					buildSelectOptions([
						{ value: "N", label: "Nominal" },
						{ value: "O", label: "Ordinal" },
						{ value: "I", label: "Interval" },
						{ value: "R", label: "Ratio" }
					], item.type) +
				'</select></div>';
				designConfigHtml = item.type === "N" ? '<div class="selection-field"><label class="selection-field-label">IV design</label><select class="form-select form-select-sm selection-inline-select iv-within-select" data-item-id="' + itemId + '">' +
					buildSelectOptions([
						{ value: "within", label: "within" },
						{ value: "between", label: "between" }
					], item.within) +
				'</select></div>' : '<div class="selection-field selection-field-empty"></div>';
			}

			if(!isIV) {
				typeConfigHtml = '<div class="selection-field"><label class="selection-field-label">DV type</label><select class="form-select form-select-sm selection-inline-select dv-type-select" data-item-id="' + itemId + '">' +
					buildSelectOptions([
						{ value: "O", label: "Ordinal" },
						{ value: "I", label: "Interval" },
						{ value: "R", label: "Ratio" }
					], item.type) +
				'</select></div>';
				designConfigHtml = '';
			}

			return '<li class="selection-item" draggable="true" data-list-type="' + listType + '" data-item-id="' + itemId + '">' +
				'<div class="selection-card' + (isIV ? ' selection-card-iv' : ' selection-card-dv') + '">' +
					'<div class="selection-card-main selection-card-primary">' +
						'<div class="selection-copy">' +
							'<div class="selection-title-row">' +
								'<span class="selection-icon">' + getDataTypeIcon(item.type) + '</span>' +
								'<textarea rows="1" class="form-control form-control-sm selection-name-input" data-list-type="' + listType + '" data-item-id="' + itemId + '" aria-label="' + (isIV ? 'Independent variable name' : 'Dependent variable name') + '">' + escapeHtml(item.name) + '</textarea>' +
							'</div>' +
							'<div class="selection-meta">' + metadata.map(function(entry) {
								return '<span class="selection-badge">' + escapeHtml(entry) + '</span>';
							}).join("") + '</div>' +
						'</div>' +
					'</div>' +
					(typeConfigHtml ? '<div class="selection-card-main selection-card-config">' + typeConfigHtml + '</div>' : '') +
					(designConfigHtml ? '<div class="selection-card-main selection-card-config">' + designConfigHtml + '</div>' : '') +
					'<div class="selection-actions">' +
						'<button type="button" class="btn btn-outline-secondary btn-sm selection-move-up" data-list-type="' + listType + '" data-item-id="' + itemId + '" aria-label="Move ' + escapeHtml(item.name) + ' up">' +
							'<i class="bi bi-arrow-up"></i>' +
						'</button>' +
						'<button type="button" class="btn btn-outline-secondary btn-sm selection-move-down" data-list-type="' + listType + '" data-item-id="' + itemId + '" aria-label="Move ' + escapeHtml(item.name) + ' down">' +
							'<i class="bi bi-arrow-down"></i>' +
						'</button>' +
						'<button type="button" id="button' + (isIV ? 'IV' : 'DV') + '_' + itemId + '" class="btn btn-outline-danger btn-sm selection-remove" data-list-type="' + listType + '" data-item-id="' + itemId + '" aria-label="Remove ' + escapeHtml(item.name) + '">' +
							'<i class="bi bi-trash"></i>' +
						'</button>' +
					'</div>' +
					(isIV && item.type === "N" ? '<div class="selection-card-levels">' +
						'<label class="selection-field-label">Levels</label>' +
						'<div class="selection-levels">' + (item.levels || []).map(function(level, index) {
							let removeDisabled = (item.levels || []).length <= 2 ? " disabled" : "";
							return '<span class="selection-level-chip">' + escapeHtml(level) + '<button type="button" class="btn btn-sm selection-level-remove" data-item-id="' + itemId + '" data-level-index="' + index + '" aria-label="Remove level ' + escapeHtml(level) + '"' + removeDisabled + '><i class="bi bi-x-lg"></i></button></span>';
						}).join("") + '</div>' +
						'<input type="text" class="form-control form-control-sm selection-level-input mt-2" data-item-id="' + itemId + '" placeholder="Add level and press Enter" />' +
					'</div>' : '') +
				'</div>' +
			'</li>';
		}

		function renderVariableLists() {
			$("#listIV").html(studyDesign.IVs.map(function(item) {
				return buildSelectionItem(item, "iv");
			}).join(""));
			$("#listDV").html(studyDesign.DVs.map(function(item) {
				return buildSelectionItem(item, "dv");
			}).join(""));
			$("#listIV .selection-name-input, #listDV .selection-name-input").each(function() {
				adjustSelectionNameInputHeight(this);
			});
			updateVariableActionState();
		}

		function adjustSelectionNameInputHeight(element) {
			if(!element) {
				return;
			}

			element.style.height = "auto";
			element.style.height = Math.max(32, element.scrollHeight) + "px";
		}

		function getVariableArray(listType) {
			return listType === "iv" ? studyDesign.IVs : studyDesign.DVs;
		}

		function removeVariableById(listType, itemId) {
			let items = getVariableArray(listType);
			let removeIndex = items.findIndex(function(item) {
				return String(item.id) === String(itemId);
			});

			if(removeIndex === -1) {
				return;
			}

			items.splice(removeIndex, 1);
			renderVariableLists();
			showSoftWaitState();
			displayDependentVariableInput();

			if(listType === "dv") {
				resetSampleSizeProgress();
			}
		}

		function moveVariableByOffset(listType, itemId, offset) {
			let items = getVariableArray(listType);
			let currentIndex = items.findIndex(function(item) {
				return String(item.id) === String(itemId);
			});

			if(currentIndex === -1) {
				return;
			}

			let nextIndex = currentIndex + offset;

			if(nextIndex < 0 || nextIndex >= items.length) {
				return;
			}

			let movedItem = items.splice(currentIndex, 1)[0];
			items.splice(nextIndex, 0, movedItem);
			renderVariableLists();
			showSoftWaitState();
			refreshPlanner();
		}

		function moveVariableToTarget(listType, draggedItemId, targetItemId, insertAfter) {
			let items = getVariableArray(listType);
			let draggedIndex = items.findIndex(function(item) {
				return String(item.id) === String(draggedItemId);
			});
			let targetIndex = items.findIndex(function(item) {
				return String(item.id) === String(targetItemId);
			});

			if(draggedIndex === -1 || targetIndex === -1 || draggedIndex === targetIndex) {
				return;
			}

			let draggedItem = items.splice(draggedIndex, 1)[0];
			let adjustedTargetIndex = items.findIndex(function(item) {
				return String(item.id) === String(targetItemId);
			});
			let insertIndex = insertAfter ? adjustedTargetIndex + 1 : adjustedTargetIndex;

			items.splice(insertIndex, 0, draggedItem);
			renderVariableLists();
			showSoftWaitState();
			refreshPlanner();
		}

		function updateVariableAndRefresh(updateFn) {
			updateFn();
			renderVariableLists();
			showSoftWaitState();
			refreshPlanner();
		}

		function addLevelToExistingIV(itemId, rawLevel) {
			let normalizedLevel = normalizeLevelValue(rawLevel);
			let targetItem = studyDesign.IVs.find(function(item) {
				return String(item.id) === String(itemId);
			});

			if(!targetItem || targetItem.type !== "N" || normalizedLevel === "") {
				return;
			}

			targetItem.levels = targetItem.levels || [];

			if(targetItem.levels.some(function(level) {
				return normalizeLevelValue(level).toLowerCase() === normalizedLevel.toLowerCase();
			})) {
				return;
			}

			targetItem.levels.push(normalizedLevel);
			updateVariableAndRefresh(function() {});
		}

		function removeLevelFromExistingIV(itemId, levelIndex) {
			let targetItem = studyDesign.IVs.find(function(item) {
				return String(item.id) === String(itemId);
			});

			if(!targetItem || !Array.isArray(targetItem.levels)) {
				return;
			}

			if(levelIndex < 0 || levelIndex >= targetItem.levels.length) {
				return;
			}

			if(targetItem.levels.length <= 2) {
				return;
			}

			targetItem.levels.splice(levelIndex, 1);
			updateVariableAndRefresh(function() {});
		}
		 
		$(document).ready(function() { 
			resetStudyDesign();
			renderVariableLists();
			syncLevelTokensFromSerializedInput();
			updateSectionVisibility();

			$("#IVForm").on("submit", function(event) {
				event.preventDefault();
			});

			$("#DVForm").on("submit", function(event) {
				event.preventDefault();
			});
			
			$("#levelsIV").hide();
			$("#withinIV").hide();
			
			$("#rowDV").hide();
			$("#rowED").hide();
			$("#rowES").hide();
			$("#rowST").hide(); 
			$("#rowWAIT").text("");
			$("#rowWAITContainer").hide();
			$("#rowWAITContainer").hide();
			
			$("#cellMANOVA").hide();
			$("#cellEquivalence").hide();
			$("#cellSampleSize").hide();
			$("#cellVariance").hide();
			$("#cellEffectMode").hide();
			$("#cellTargetPower").hide();
			$("#cellWithinCorrelation").hide();
			$("#cellEffectSize").hide();
			$("#cellDeltaMeans").hide();
			
			$("#sampleSizeSlider").hide(); 
			
			$("input[name='nameDV']").attr('placeholder', "Enter DV name...");
			$("input[name='enterLevelsIV']").attr('placeholder', "Enter levels (comma-separated)");
			$("#levelsTokenInput").attr('placeholder', "Type a level and press Enter");
			$("input[name='nameIV']").attr('placeholder', "Enter IV name..."); 
			$("#ivNameFeedback, #dvNameFeedback, #ivLevelsFeedback").hide();
			
			$("select[name='selectIVType']").append(new Option('Please select', ""));
            $("select[name='selectIVType']").append(new Option('Nominal (types, categories, gender, animals, ZIP codes,...)', "N")); 
            $("select[name='selectIVType']").append(new Option('Ordinal (marks, ranks, single Likert items, counts, ...)', "O")); 
            $("select[name='selectIVType']").append(new Option('Interval (arbitrary zero: distance, time, IQ, temperature in C, ...)', "I")); 
            $("select[name='selectIVType']").append(new Option('Ratio (fixed zero: age, volume, temperature in K, scores, bandwidth,...)', "R"));  
			
			$("select[name='selectDVType']").append(new Option('Please select', ""));
            $("select[name='selectDVType']").append(new Option('Nominal (types, categories, gender, animals, ZIP codes,...)', "N")); 
            $("select[name='selectDVType']").append(new Option('Ordinal (marks, ranks, single Likert items, counts, ...)', "O")); 
            $("select[name='selectDVType']").append(new Option('Interval (arbitrary zero: distance, time, IQ, temperature in C, ...)', "I")); 
            $("select[name='selectDVType']").append(new Option('Ratio (fixed zero: age, volume, temperature in K, scores, bandwidth,...)', "R"));
			$("select[name='selectDVType'] option[value='N']").attr("disabled","disabled");    
			
			$("select[name='selectIVwithin']").append(new Option('Please select', ""));
			$("select[name='selectIVwithin']").append(new Option('within', "within"));
			$("select[name='selectIVwithin']").append(new Option('between', "between"));
			
			$("input[name='manovaCheckBox']").prop( 'checked', false ); 			
			
			$("#btnExample2x3Within").click(function() { example2x3Within(); }); 		
			$("#btnExample2x4Mixed").click(function()  { example2x4Mixed(); }); 		
			$("#btnExampleRegression").click(function() { exampleRegression(); }); 		
			
			$("select[name='selectIVType']").change(function() { 
				if($("select[name='selectIVType']").val() == "N"){
					$("#levelsIV").show();
					$("#withinIV").show();
					syncLevelTokensFromSerializedInput();
				} else {
					$("#levelsIV").hide();
					$("#withinIV").hide();
					clearLevelTokens();
				}
				clearFieldValidationState("input[name='nameIV']", "#ivNameFeedback");
				$("#levelsTokenShell").removeClass("is-invalid");
				$("#ivLevelsFeedback").hide();
			});	

			$("input[name='nameIV']").on("input", function() {
				if($.trim($(this).val()) !== "") {
					clearFieldValidationState(this, "#ivNameFeedback");
				}
			});

			$("input[name='nameDV']").on("input", function() {
				if($.trim($(this).val()) !== "") {
					clearFieldValidationState(this, "#dvNameFeedback");
				}
			});

			$("#levelsTokenInput").on("keydown", function(event) {
				if(event.key === "Enter" || event.key === ",") {
					event.preventDefault();
					addLevelToken($(this).val());
				}
			});

			$("#levelsTokenInput").on("blur", function() {
				addLevelToken($(this).val());
			});

			$("#levelsTokenList").on("click", ".level-token-remove", function() {
				let levels = getCurrentLevelTokens();
				let levelIndex = parseInt($(this).data("level-index"), 10);

				if(levelIndex >= 0 && levelIndex < levels.length) {
					levels.splice(levelIndex, 1);
					setCurrentLevelTokens(levels);
				}
			});

			$("#listIV, #listDV").on("click", ".selection-remove", function() {
				removeVariableById($(this).data("list-type"), $(this).data("item-id"));
			});

			$("#listIV, #listDV").on("click", ".selection-move-up", function() {
				moveVariableByOffset($(this).data("list-type"), $(this).data("item-id"), -1);
			});

			$("#listIV, #listDV").on("click", ".selection-move-down", function() {
				moveVariableByOffset($(this).data("list-type"), $(this).data("item-id"), 1);
			});

			$("#listIV, #listDV").on("input", ".selection-name-input", function() {
				let listType = $(this).data("list-type");
				let itemId = $(this).data("item-id");
				let nextName = $.trim($(this).val());
				let items = getVariableArray(listType);
				let targetItem = items.find(function(item) {
					return String(item.id) === String(itemId);
				});

				adjustSelectionNameInputHeight(this);
				$(this).toggleClass("is-invalid", nextName === "");

				if(!targetItem || nextName === "") {
					return;
				}

				if(targetItem.name === nextName) {
					return;
				}

				targetItem.name = nextName;
				showSoftWaitState();
				refreshPlanner();
			});

			$("#listIV, #listDV").on("keydown", ".selection-name-input", function(event) {
				if(event.key === "Enter") {
					event.preventDefault();
				}
			});

			$("#listIV").on("change", ".iv-within-select", function() {
				let itemId = $(this).data("item-id");
				let nextValue = $(this).val();
				let targetItem = studyDesign.IVs.find(function(item) {
					return String(item.id) === String(itemId);
				});

				if(!targetItem || targetItem.within === nextValue) {
					return;
				}

				targetItem.within = nextValue;
				renderVariableLists();
				showSoftWaitState();
				refreshPlanner();
			});

			$("#listIV").on("change", ".iv-type-select", function() {
				let itemId = $(this).data("item-id");
				let nextValue = $(this).val();
				let targetItem = studyDesign.IVs.find(function(item) {
					return String(item.id) === String(itemId);
				});

				if(!targetItem || targetItem.type === nextValue) {
					return;
				}

				targetItem.type = nextValue;

				if(nextValue === "N") {
					targetItem.within = targetItem.within === "between" ? "between" : "within";
					targetItem.levels = targetItem.levels && targetItem.levels.length >= 2 ? targetItem.levels.slice(0, Math.max(2, targetItem.levels.length)) : ["Level1", "Level2"];
				} else {
					targetItem.within = "within";
					targetItem.levels = [];
				}

				renderVariableLists();
				showSoftWaitState();
				refreshPlanner();
			});

			$("#listDV").on("change", ".dv-type-select", function() {
				let itemId = $(this).data("item-id");
				let nextValue = $(this).val();
				let targetItem = studyDesign.DVs.find(function(item) {
					return String(item.id) === String(itemId);
				});

				if(!targetItem || targetItem.type === nextValue) {
					return;
				}

				targetItem.type = nextValue;
				renderVariableLists();
				showSoftWaitState();
				refreshPlanner();
			});

			$("#listIV").on("click", ".selection-level-remove", function() {
				removeLevelFromExistingIV($(this).data("item-id"), parseInt($(this).data("level-index"), 10));
			});

			$("#listIV").on("keydown", ".selection-level-input", function(event) {
				if(event.key === "Enter" || event.key === ",") {
					event.preventDefault();
					addLevelToExistingIV($(this).data("item-id"), $(this).val());
					$(this).val("");
				}
			});

			$("#listIV, #listDV").on("dragstart", ".selection-item", function(event) {
				let dragEvent = event.originalEvent;

				$(".selection-item").removeClass("drag-over drag-over-after");
				$(this).addClass("dragging");
				dragEvent.dataTransfer.effectAllowed = "move";
				dragEvent.dataTransfer.setData("text/plain", JSON.stringify({
					listType: $(this).data("list-type"),
					itemId: $(this).data("item-id")
				}));
			});

			$("#listIV, #listDV").on("dragover", ".selection-item", function(event) {
				let dragEvent = event.originalEvent;
				let bounds = this.getBoundingClientRect();
				let insertAfter = (dragEvent.clientY - bounds.top) > (bounds.height / 2);

				event.preventDefault();
				$(".selection-item").removeClass("drag-over drag-over-after");
				$(this).addClass(insertAfter ? "drag-over-after" : "drag-over");
			});

			$("#listIV, #listDV").on("dragleave", ".selection-item", function() {
				$(this).removeClass("drag-over drag-over-after");
			});

			$("#listIV, #listDV").on("drop", ".selection-item", function(event) {
				let payload = null;
				let bounds = this.getBoundingClientRect();
				let insertAfter = (event.originalEvent.clientY - bounds.top) > (bounds.height / 2);

				event.preventDefault();

				try {
					payload = JSON.parse(event.originalEvent.dataTransfer.getData("text/plain"));
				} catch (error) {
					payload = null;
				}

				$(".selection-item").removeClass("drag-over drag-over-after dragging");

				if(!payload || payload.listType !== $(this).data("list-type")) {
					return;
				}

				moveVariableToTarget(payload.listType, payload.itemId, $(this).data("item-id"), insertAfter);
			});

			$("#listIV, #listDV").on("dragend", ".selection-item", function() {
				$(".selection-item").removeClass("drag-over drag-over-after dragging");
			});
			
			$("input[name='manovaCheckBox']").change(function() { 
				refreshPlanner();
			});
			
			$("input[name='normalityCheckBox']").change(function() { 
				refreshPlanner();
			}); 
			
			$("#samplesInputId").change(function() { 
				manualSampleSizeUpdate = true; 
				manualUpdate();
				manualSampleSizeUpdate = false;
			});
			
			$("#varianceInputId").change(function() { 
				manualUpdate();
			});
			
			/* Not implemented yet */
			/*
			$("#equivalenceCheckBox").change(function() { 
				manualUpdate();  
			});
			*/

			$("#meanDeltaInputId").change(function() { 
				manualUpdate(); 
			});

			$("#effectSizeModeId").change(function() {
				updateEffectInputControls();
				manualUpdate();
			});

			$("#effectSizeInputId").change(function() {
				manualUpdate();
			});

			$("#btnMediumEffect").click(function() {
				const effectMode = getEffectInputMode();

				if (effectMode === "d") {
					$("#effectSizeInputId").val("0.500");
				} else if (effectMode === "eta") {
					$("#effectSizeInputId").val("0.059");
				} else if (effectMode === "f") {
					$("#effectSizeInputId").val("0.250");
				} else {
					$("#meanDeltaInputId").val("0.20");
					$("#effectsizeOutputId").val("20 %");
					$("#varianceInputId").val("0.40");
					$("#varianceOutputId").val("40 %");
				}

				manualUpdate();
			});

			function updateEffectInputControls() {
				const effectMode = getEffectInputMode();
				const usesMeanVariance = effectMode === "means";
				const hasWithin = studyDesign && studyDesign.withinIVs && studyDesign.withinIVs.length > 0;

				$("#cellDeltaMeans").toggle(usesMeanVariance);
				$("#cellVariance").toggle(usesMeanVariance);
				$("#cellWithinCorrelation").hide();
				$("#cellTargetPower").hide();

				if(hasWithin) {
					$("#withinCorrelationInputId").val("0.50");
					$("#withinCorrelationOutputId").val("0.5");
				}

				$("#targetPowerInputId").val("0.80");
				$("#targetPowerOutputId").val("80 %");

				$("#effectSizeModeHint").hide().text("");

				if (effectMode === "d") {
					$("#effectSizeInputId").val($("#effectSizeInputId").val() || "0.500");
				}
			}

			function manualUpdate() {
				if(plannerUpdateSuspended) {
					return;
				}

				clearOutputAndWait();
				refreshPlanner();
			}
			
			$("#addIV").click(function() { 
				IVs++;
				$("input[name='nameIV']").prop("required", true); 
				$("select[name='selectIVType']").prop("required", true); 		
				syncLevelTokensFromSerializedInput();
				
				if(!validateCurrentIVInputs(true)) return;
				if($("select[name='selectIVType']").val() == "") return;
				
				if($("select[name='selectIVType']").val() == "N") {
					if(getCurrentLevelTokens().length < 2) return; 
				} else { 
					$("select[name='selectIVwithin'] option:eq(1)").prop("selected", true);
				}
				
				let levels = [ ];
				let IV = {
					"id": 0,
					"name": "",
					"type": "",
					"levels": [],
					"within": "" };
								
				if($("select[name='selectIVType']").val() == "N") {
					$("#withinIV").show();
					$("#levelsIV").show();  
					levels = getCurrentLevelTokens();
					IV.levels = levels; 					
				} else {
					$("#levelsIV").hide();
					$("#withinIV").hide();
				}
								
				IV.id = IVs;
				IV.name = $("input[name='nameIV']").val();
				IV.type = $("select[name='selectIVType']").val();
				IV.within = $("select[name='selectIVwithin']").val();
				
				studyDesign.IVs.push(IV); 
				renderVariableLists();
				
				$("input[name='nameIV']").val("");
				$("select[name='selectIVType'] option:eq(0)").prop("selected", true);
				$("select[name='selectIVwithin'] option:eq(0)").prop("selected", true);
				clearLevelTokens();
					
				$("#levelsIV").hide();
				$("#withinIV").hide();	

				showSoftWaitState();
				displayDependentVariableInput();	
			});
			
			function displayDependentVariableInput(){  	
				if(studyDesign.IVs.length > 0){
					$("input[name='nameIV']").prop("required", false); 
					$("select[name='selectIVType']").prop("required", false); 
					$("select[name='selectIVwithin']").prop("required", false); 
					$("input[name='enterLevelsIV']").prop("required", false); 
					$("input[name='nameDV']").prop("required", true); 
					$("select[name='selectDVType']").prop("required", true); 
					$("#rowDV").show(); 
				} else {
					$("input[name='nameIV']").prop("required", true); 
					$("select[name='selectIVType']").prop("required", true); 
					$("select[name='selectIVwithin']").prop("required", true); 
					$("input[name='enterLevelsIV']").prop("required", true); 
					$("input[name='nameDV']").prop("required", false); 
					$("select[name='selectDVType']").prop("required", false); 
					$("#rowES").hide();
					$("#rowDV").hide();
					$("#cellSampleSize").hide();
					$("#cellVariance").hide();
					$("#cellEffectMode").hide();
					$("#cellTargetPower").hide();
					$("#cellWithinCorrelation").hide();
					$("#cellEffectSize").hide();
					$("#cellDeltaMeans").hide();
					$("#cellMANOVA").hide();
					$("#rowWAIT").text("No study design possible..."); 
			$("#rowWAITContainer").show();
					updateSectionVisibility();
					return;
				}	 	 
				
				if(studyDesign.DVs.length > 0 && studyDesign.IVs.length > 0){  
					$("#cellEffectMode").hide();
					$("#cellVariance").show();
					$("#cellEffectSize").show();
					$("#cellDeltaMeans").show();
					$("#cellSampleSize").show();
					updateEffectInputControls();
				} else {
					$("#cellSampleSize").hide();
					$("#cellVariance").hide();
					$("#cellEffectMode").hide();
					$("#cellTargetPower").hide();
					$("#cellWithinCorrelation").hide();
					$("#cellEffectSize").hide();
					$("#cellDeltaMeans").hide();
					$("#cellMANOVA").hide(); 
					$("#rowWAIT").text("No study design possible..."); 
			$("#rowWAITContainer").show();
					updateSectionVisibility();
					return;
				}
					
				updateSectionVisibility();
				refreshPlanner();	
			}
			
			$("#addDV").click(function() {
				$("input[name='nameDV']").prop("required", true); 
				$("select[name='selectDVType']").prop("required", true); 
				
				if(!validateCurrentDVInputs(true)) return;
				if($("select[name='selectDVType']").val() == "") return;
			
				let iconDVstr = "";
				let DV = {
					"id": 0,
					"name": "",
					"type": "" };
				DVs++;
				
				DV.id = DVs;
				DV.name = $("input[name='nameDV']").val();
				DV.type = $("select[name='selectDVType']").val(); 
				studyDesign.DVs.push(DV); 
				renderVariableLists();
				
				$("input[name='nameDV']").val("");
				$("select[name='selectDVType'] option:eq(0)").prop("selected", true); 
				resetSampleSizeProgress();
				showSoftWaitState();
				refreshPlanner();
				
				$("#rowWAIT").text("Please wait..."); 
			$("#rowWAITContainer").show();
				$("#cellVariance").show();
				$("#cellDeltaMeans").show();
				$("#cellEffectSize").show();
			}); 
			 
			refreshPlanner = function() { 
				if(plannerUpdateSuspended) {
					return;
				}

				if(studyDesign.DVs.length > 0){ 
					$("input[name='nameDV']").prop("required", false); 
					$("select[name='selectDVType']").prop("required", false); 						
				} else { 
					$("input[name='nameDV']").prop("required", true); 
					$("select[name='selectDVType']").prop("required", true);  
				}

				updateSectionVisibility();
				  
				if(studyDesign.DVs.length > 0 && studyDesign.IVs.length > 0) recomputePlanner();	 
			};
				
			function recomputePlanner() {  
				let anIVHasMoreThanTwoLevels = false;

				$("#cellSampleSize").show(); 

				if(manualSampleSizeUpdate) {
					$("#sampleSizeSlider").show(); 
					$("#sampleSizePleaseWait").hide(); 
				} else {
					$("#sampleSizeSlider").hide();  
					$("#sampleSizePleaseWait").show(); 
				}

				$.each(studyDesign.IVs, function(i){  
					if(studyDesign.IVs[i].levels.length > 2) anIVHasMoreThanTwoLevels = true; 
				});
				
				if(studyDesign.IVs.length == 1 && studyDesign.DVs.length >= 1 && anIVHasMoreThanTwoLevels == false) $("#cellEquivalence").show();
				else $("#cellEquivalence").hide(); 
				
				let studyHasParametricData = false;
				$.each(studyDesign.DVs, function(i){  
					if(studyDesign.DVs[i].type == "I" || studyDesign.DVs[i].type == "R")  studyHasParametricData = true; 
				}); 
				
				studyDesign.MANOVA = $("input[name='manovaCheckBox']").prop('checked');
				 
				if(studyDesign.DVs.length > 0 && studyDesign.IVs.length > 0) {
					let IVType = $("select[name='selectIVType']").val(); 
				} 
				
				studyDesign.withinIVs = getItemsInArray(getItemsInArray(studyDesign.IVs, "type", "N"), "within", "within"); 
				studyDesign.betweenIVs = getItemsInArray(getItemsInArray(studyDesign.IVs, "type", "N"), "within", "between"); 
				
				studyDesign.nonOrdinalIVs = [];
				let ordinalIVs = getItemsInArray(getItemsInArray(studyDesign.IVs, "type", "O"), "within", "within"); 
				let intervalIVs = getItemsInArray(getItemsInArray(studyDesign.IVs, "type", "I"), "within", "within"); 
				let ratioIVs = getItemsInArray(getItemsInArray(studyDesign.IVs, "type", "R"), "within", "within"); 
				studyDesign.nonOrdinalIVs = ordinalIVs.concat(intervalIVs).concat(ratioIVs);
				
				let allBetweens = [];  
				$.each(studyDesign.betweenIVs, function(i){  
					$.each(studyDesign.betweenIVs[i].levels, function(j){   
						allBetweens.push(studyDesign.betweenIVs[i].levels);
					});
				});  
				
				let allWithins = []; 
					$.each(studyDesign.withinIVs, function(i){ 
						if(studyDesign.withinIVs[i].levels.length > 1)
							allWithins.push(studyDesign.withinIVs[i].levels);
				});
				
				studyDesign.betweenConditions = combineArrays(allBetweens.filter(onlyUniqueValuesInArray));
				studyDesign.withinConditions = combineArrays(allWithins);
				studyDesign.allConditions = studyDesign.betweenConditions.concat(studyDesign.withinConditions);  
				studyDesign.allCombinations = combineArrays(allWithins.concat(allBetweens.filter(onlyUniqueValuesInArray)));
				  
				$.each(studyDesign.betweenConditions, function(i){ 
					studyDesign.betweenConditions[i] = studyDesign.betweenConditions[i].slice(0, -1);
				}); 
				
				$.each(studyDesign.withinConditions, function(i){ 
					studyDesign.withinConditions[i] = studyDesign.withinConditions[i].slice(0, -1);
				});
				
				$.each(studyDesign.allConditions, function(i){ 
					studyDesign.allConditions[i] = studyDesign.allConditions[i].slice(0, -1);
				});
				
				setEffectSizes();
				sampleSize = estimateInitialSampleSizeLocally();  
			}
			  
			updateEffectInputControls();
			if(debug) $("#btnExample2x3Within").click();
		});  

		function runExampleSetup(setupCallback) {
			plannerUpdateSuspended = true;

			try {
				resetStudyDesign();
				renderVariableLists();
				clearLevelTokens();
				setupCallback();
			} finally {
				plannerUpdateSuspended = false;
			}

			$("#meanDeltaInputId").trigger("change");
		}
		
		function setEffectSizes() {
			let effectSizes = resolveEffectSizes();
			let cohensD = effectSizes.cohensD.toFixed(3);
			let cohensF = effectSizes.cohensF.toFixed(3);
			let partialEtaSq = effectSizes.partialEtaSquared.toFixed(3);
			let sharedInterpretation = interpretCohensf(parseFloat(cohensF));
			let text = "<strong>" + sharedInterpretation + " effect</strong><br />Cohen's <i>d</i> = " + cohensD + ", Cohen's <i>f</i> = " + cohensF + ", <i>&eta;<sub>p</sub><sup>2</sup></i> = " + partialEtaSq;

			if (hasNominalFactors()) {
				text += "<br /><small>" + effectSizes.note + "</small>";
			}

			if (hasRegressionPredictors()) {
				let rSquared = (effectSizes.cohensF * effectSizes.cohensF) / (1 + effectSizes.cohensF * effectSizes.cohensF);
				text += "<br /><small>Reference regression effect: <i>f<sup>2</sup></i> = " + (effectSizes.cohensF * effectSizes.cohensF).toFixed(3) + ", expected <i>R<sup>2</sup></i> = " + rSquared.toFixed(3) + ".</small>";
			}

			$("#effectSizeLabel").html(text);
		}
		
		function setPowerAnalysesAndEffectSizes() {
			$("#power").html(""); 

			lastAnovaPowerResult = null;
			lastRegressionPowerResult = null;
			lastTTestPowerResult = null;
			serverRequestRunning = true;

			let steps = Math.max(1, studyDesign.allConditions.length);
			let sliderMax = Math.max(200, parseInt(sampleSize, 10) + (steps * 4));
			studyDesign.samples = setSlider("#samplesInputId", "#samplesOutputId", sampleSize, 0, sliderMax, steps);

			$("#samplesOutputId").text($("#samplesInputId").val());

			let remainingJobs = 0;

			function finishPowerUpdate() {
				remainingJobs--;

				if(remainingJobs <= 0) {
					renderExperimentalDesignGuidance();
					renderStatisticalTestGuidance();
					serverRequestRunning = false;
				}
			}

			if(hasNominalFactors()) {
				remainingJobs++;
				renderNominalPowerEstimate(parseInt(sampleSize, 10), finishPowerUpdate);
			}

			if(hasRegressionPredictors()) { 
				remainingJobs++;
				renderRegressionPowerEstimate(
					studyDesign.nonOrdinalIVs.length, 
					parseInt(sampleSize, 10),
					finishPowerUpdate
				);
			}

			if(remainingJobs === 0) {
				renderExperimentalDesignGuidance();
				renderStatisticalTestGuidance();
				serverRequestRunning = false;
			}

		}
			
		function getDesignAlignmentMultiple() {
			let betweenCells = Math.max(1, studyDesign.betweenConditions && studyDesign.betweenConditions.length ? studyDesign.betweenConditions.length : 1);
			let withinBlock = 1;

			if(studyDesign.withinConditions && studyDesign.withinConditions.length > 0) {
				if(studyDesign.withinConditions.length <= 3) {
					withinBlock = permutations(studyDesign.withinConditions).length;
				} else if(studyDesign.withinConditions.length <= 12) {
					withinBlock = studyDesign.withinConditions.length;
				}
			}

			return Math.max(1, betweenCells * withinBlock);
		}

		function renderNominalPowerEstimate(participants, callback) {
			let effectSizes = resolveEffectSizes();
			let nominalFactors = getNominalFactors();

			window.setTimeout(function() {
				try {
					if(isTTestScenario()) {
						lastTTestPowerResult = StudyPowerEngine.estimateTTestModel({
							paired: studyDesign.withinIVs.length > 0,
							cohenD: effectSizes.cohensD,
							alpha: 0.05,
							targetPower: getTargetPower(),
							withinCorrelation: getCurrentWithinCorrelation()
						});
						lastTTestPowerResult.selectedN = participants;
						lastTTestPowerResult.selectedResult = computeTTestPowerAtSampleSize(participants, effectSizes.cohensD, studyDesign.withinIVs.length > 0, getCurrentWithinCorrelation());
						showTTestPowerAndEffectSizes(lastTTestPowerResult, participants);
					} else {
						lastAnovaPowerResult = StudyPowerEngine.estimateAnovaModel({
							factors: nominalFactors,
							effectSizeF: effectSizes.cohensF,
							alpha: 0.05,
							targetPower: getTargetPower(),
							withinCorrelation: getCurrentWithinCorrelation()
						});
						showANOVAPowerAndEffectSizes(lastAnovaPowerResult, participants);
					}

					$("#cellSampleSize").show();
				} catch (error) {
					console.error(error);
					$("#rowWAIT").text("Power estimation failed. Please check the browser console.");
					$("#sampleSizePleaseWait").hide();
				} finally {
					if(typeof callback === "function") {
						callback();
					}
				}
			}, 0);
		}

		function estimateInitialSampleSizeLocally() { 

			let effectSizes = resolveEffectSizes();

			if(!serverRequestRunning) { 
				if(!manualSampleSizeUpdate) { 
					serverRequestRunning = true; 

					window.setTimeout(function() {
						try {
							let estimates = [];

							if(hasNominalFactors()) {
								if(isTTestScenario()) {
									let tTestSampleSize = StudyPowerEngine.estimateTTestModel({
										paired: studyDesign.withinIVs.length > 0,
										cohenD: effectSizes.cohensD,
										alpha: 0.05,
										targetPower: getTargetPower(),
										withinCorrelation: getCurrentWithinCorrelation(),
										includeCurvePoints: false
									});
									studyDesign.minimumSampleSize = tTestSampleSize.minimumN;
									estimates.push(tTestSampleSize.minimumN);
								} else {
									let anovaSampleSize = StudyPowerEngine.estimateSampleSizeForAnova({
										factors: getNominalFactors(),
										effectSizeF: effectSizes.cohensF,
										alpha: 0.05,
										targetPower: getTargetPower(),
										withinCorrelation: getCurrentWithinCorrelation(),
										includeCurvePoints: false
									});
									studyDesign.minimumSampleSize = anovaSampleSize.minimumN;
									estimates.push(anovaSampleSize.minimumN);
								}
							}

							if(hasRegressionPredictors()) {
								let regressionSampleSize = StudyPowerEngine.estimateSampleSizeForRegression({
									predictors: studyDesign.nonOrdinalIVs.length,
									effectSizeFSquared: effectSizes.cohensF * effectSizes.cohensF,
									alpha: 0.05,
									targetPower: getTargetPower(),
									includeCurvePoints: false
								});
								studyDesign.regressionMinimumSampleSize = regressionSampleSize.minimumN;
								estimates.push(regressionSampleSize.minimumN);
							}

							let minimumEstimate = estimates.length > 0 ? Math.max.apply(null, estimates) : 0;
							let requiredSampleSize = roundUpToNextDivisible(minimumEstimate, getDesignAlignmentMultiple());
							studyDesign.minimumSampleSize = minimumEstimate;
							studyDesign.requiredSampleSize = requiredSampleSize;
							sampleSize = requiredSampleSize;

							let steps = Math.max(1, studyDesign.allConditions.length);
							let sliderMax = Math.max(200, parseInt(sampleSize, 10) + (steps * 4));
							studyDesign.samples = setSlider("#samplesInputId", "#samplesOutputId", sampleSize, 0, sliderMax, steps);  
							markSampleSizeReady();
							 
							$("#sampleSizePleaseWait").hide(); 
							$("#sampleSizeSlider").show(); 

							if(studyDesign.DVs.length > 1 && studyDesign.IVs.length > 0 ){
								$("#cellMANOVA").show();
							} else {
								$("#cellMANOVA").hide();
								$("input[name='manovaCheckBox']").prop("checked", false);
							}

							setPowerAnalysesAndEffectSizes();
						} catch (error) {
							console.error(error);
							$("#rowWAIT").text("Sample-size estimation failed. Please check the browser console.");
							$("#sampleSizePleaseWait").hide();
							$("#sampleSizeSlider").hide();
						} finally {
							serverRequestRunning = false;
						}
					}, 0);
				} else { 
					sampleSize = $("#samplesInputId").val();  
					markSampleSizeReady();
					setPowerAnalysesAndEffectSizes();	 
				}
			}
			return sampleSize;
			
		}
		
		function renderRegressionPowerEstimate(IVs, participants, callback) {    
			if(!serverRegressionRequestRunning) {
				serverRegressionRequestRunning = true;

				window.setTimeout(function() {
					try {
						let effectSizes = resolveEffectSizes();
						let regressionSampleSizeResult = StudyPowerEngine.estimateSampleSizeForRegression({
							predictors: parseInt(IVs, 10),
							effectSizeFSquared: effectSizes.cohensF * effectSizes.cohensF,
							alpha: 0.05,
							targetPower: getTargetPower(),
							includeCurvePoints: true
						});
						let regressionPowerResult = StudyPowerEngine.estimateRegressionPower({
							predictors: parseInt(IVs, 10),
							participants: parseInt(participants, 10),
							effectSizeFSquared: effectSizes.cohensF * effectSizes.cohensF,
							alpha: 0.05,
						});

						lastRegressionPowerResult = Object.assign({}, regressionPowerResult, {
							minimumN: studyDesign.regressionMinimumSampleSize || regressionSampleSizeResult.minimumN || participants,
							curvePoints: regressionSampleSizeResult.curvePoints || [],
							effectRow: regressionSampleSizeResult.effectRow || null
						});
						showRegressionPowerAndEffectSizes(lastRegressionPowerResult, participants);
					} catch (error) {
						console.error(error);
						$("#rowWAIT").text("Regression power estimation failed. Please check the browser console.");
						$("#sampleSizePleaseWait").hide();
					} finally {
						serverRegressionRequestRunning = false;

						if(typeof callback === "function") {
							callback();
						}
					}
				}, 0);
			} 
		}  
		
		function clearOutputAndWait() {
			if(studyDesign.IVs.length > 0 && studyDesign.DVs.length > 0) {
				$("#rowWAIT").text("Please wait..."); 
				$("#rowWAITContainer").show();
				$("#cellMANOVA").hide();
				if($("#sampleSizeSlider").is(":hidden")) $("#sampleSizePleaseWait").show();
				else  $("#sampleSizePleaseWait").hide();
				$("#cellSampleSize").show(); 
			} else {
				$("#rowWAIT").text("No study design possible..."); 
				$("#rowWAITContainer").show();
				resetSampleSizeProgress();
				destroyPowerChart();
				$("#rowES").hide();
				$("#rowST").hide(); 
				$("#rowED").hide(); 
				$("#cellMANOVA").hide();
				$("#cellEquivalence").hide();
				$("#cellSampleSize").hide();
				$("#cellVariance").hide(); 
				$("#cellEffectMode").hide();
				$("#cellTargetPower").hide();
				$("#cellWithinCorrelation").hide();
				$("#cellDeltaMeans").hide();
			}
		}

		function showSoftWaitState() {
			if(studyDesign.IVs.length > 0 && studyDesign.DVs.length > 0) {
				$("#rowWAIT").text("Please wait...");
				$("#rowWAITContainer").show();
			}
		}
		
		function buildStudyDesignString() {
			let studyDesignStr = ""; 

			$.each(studyDesign.betweenIVs, function(i){  
				studyDesignStr += studyDesign.betweenIVs[i].levels.length + "b*";
			}); 
			
			if(studyDesign.withinIVs.length == 0) studyDesignStr = studyDesignStr.slice(0, -1);
			
			$.each(studyDesign.withinIVs, function(i){  
				studyDesignStr += studyDesign.withinIVs[i].levels.length + "w*";
			}); 

			$.each(studyDesign.nonOrdinalIVs, function(i){  
				studyDesignStr += "2w*";
			}); 
			
			if(studyDesign.withinIVs.length > 0 || studyDesign.nonOrdinalIVs.length > 0) studyDesignStr = studyDesignStr.slice(0, -1); 

			return studyDesignStr;
		}
		function renderExperimentalDesignGuidance(){ 
			$("#rowED").show();
			  
			let resultStr = '<div class="accordion">';

			if(studyDesign.betweenIVs.length > 0) {  
				resultStr += '<div class="accordion-item" id="accordionBetween"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseBetween" aria-controls="accordionBetween"><h6 class="accordion-header">' + getDataTypeIcon("M") + ' Assignment of conditions for your between-subject IVs (subjects are <i>split</i> into groups of your conditions)</h6></button><div id="collapseBetween" class="accordion-collapse collapse" aria-labelledby="panelsStayOpen-headingOne"><div class="accordion-body bg-light">Draw a random sample from a group or assign your subjects randomly and equally to each of the following ones: ' + arrayToDesignSequence(studyDesign.betweenConditions, "between", studyDesign.samples) + 'Please note that variance of measures from between-subject designs can be quite high. Please consider multiple task repetitions, equal balancing of groups, and as many samples as possible for these conditions (examples see above). In between-subject designs, the subjects are generally blind to the other conditions.</div></div></div>'; 
			}
			
			if(studyDesign.withinIVs.length > 0) {   
				resultStr += '<div class="accordion-item" id="accordionWithin"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseWithin" aria-controls="accordionWithin"><h6 class="accordion-header">' + getDataTypeIcon("M") + ' Sequence of conditions for your within-subject IVs (conditions to which <i>all</i> subjects are exposed to)</h6></button><div id="collapseWithin" class="accordion-collapse collapse" aria-labelledby="headingOne" data-bs-parent="#accordionWithin"><div class="accordion-body bg-light">';
				if(studyDesign.withinConditions.length <= 3) { 
					resultStr += "To avoid sequence effects order the " + studyDesign.withinConditions.length + " conditions of your within-subject IVs into <i>permutations</i>. Repeat the permutations with a multiple of " + permutations(studyDesign.withinConditions).length + ". For example with " + (permutations(studyDesign.withinConditions).length * 2) + ", " +  (permutations(studyDesign.withinConditions).length * 3) + ", " +  (permutations(studyDesign.withinConditions).length * 4) + "... subjects.<div class=\"mt-3\">" + arrayToDesignSequence(studyDesign.withinConditions, "permutations") + "</div>"; 
				}
				if(studyDesign.withinConditions.length > 3 && studyDesign.withinConditions.length <= 12) { 
					resultStr += "To avoid sequence effects order the " + studyDesign.withinConditions.length + " conditions of your within-subject IVs using a <i>" + studyDesign.withinConditions.length + " &times; " + studyDesign.withinConditions.length + " balanced Latin Square</i>. Repeat the Latin Square with a multiple of " + (studyDesign.withinConditions.length) + ". For example with " + (studyDesign.withinConditions.length * 2) + ", " +  (studyDesign.withinConditions.length * 3) + ", " +  (studyDesign.withinConditions.length * 4) + "... subjects.<div class=\"mt-3\">" + arrayToDesignSequence(studyDesign.withinConditions, "latinSquare") + "</div>";
				}
				if(studyDesign.withinConditions.length > 12) { 
					resultStr += "To avoid sequence effects put the " + studyDesign.withinConditions.length + " following conditions into a <i>pseudo-randomized order</i>. For example:<div class=\"mt-3\">" + arrayToDesignSequence(studyDesign.withinConditions, "shuffle", studyDesign.samples) + "</div>"; 
				}  
				resultStr += "</div></div></div>";
			} 
			
			if(studyDesign.nonOrdinalIVs.length > 0) {   
				resultStr += '<div class="accordion-item" id="accordionWithinRegression"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseWithinRegression" aria-controls="accordionWithinRegression"><h6 class="accordion-header">' + getDataTypeIcon("M") + ' Experimental Designs with Functional Outcome</h6></button><div id="collapseWithinRegression" class="accordion-collapse collapse" aria-labelledby="headingOne" data-bs-parent="#accordionWithinRegression"><div class="accordion-body bg-light">';
				resultStr += "Run your study will a random sample and take your measures. Any predictor (measure, parameter, etc.) can be your within-subject variable and coefficient of your (linear) model, any outcome can be your dependent variable. Using this design your dependent variable <i>f(x)</i> will become a function of your predictor <i>x</i>. Such designs often have the problem of separating cause and effect from each other, as many factors can be the subtrate of the same correlation. For this reason, predictors are also used as covariates, since they cannot be controlled but can be measured." 
				resultStr += "</div></div></div>";
			}
			
			resultStr+='</div>';
			$("#design").html(resultStr);
		}
		
		function renderStatisticalTestGuidance(){
			$("#rowST").show(); 
			$("#rowWAIT").text("");
			$("#rowWAITContainer").hide();
			let resultStr = ""; 
			let withinIVs = getItemsInArray(studyDesign.IVs, "within", "within");
			let betweenIVs = getItemsInArray(studyDesign.IVs, "within", "between");
			let nominalIVs = getItemsInArray(studyDesign.IVs, "type", "N");   
			
			if(studyDesign.MANOVA) resultStr += '<div class="accordion-item" id="accordionMANOVA"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseMANOVA"  aria-controls="accordionMANOVA"><h6 class="accordion-header">' + getDataTypeIcon("M") + ' Inferential statistics requires a ' + number2words(studyDesign.IVs.length) + '-factorial ' + ((withinIVs.length >= 1 && betweenIVs.length >= 1) ? 'mixed-design ' : ' ') + 'MANOVA</h6></button><div id="collapseMANOVA" class="accordion-collapse collapse" aria-labelledby="panelsStayOpen-headingOne"><div class="accordion-body bg-light"><strong>Statistical test:</strong></br><code>model <- manova(cbind(' + getNamesFromArray(studyDesign.DVs, ", ", "name").slice(0, -2) + ') ~ ' + getNamesFromArray(studyDesign.IVs, " * ", "name").slice(0, -2) + ', data = data)<br />summary(model)<br />summary.aov(model)</code></br>for DVs that are significant (p &#8804; .05) you can perform univariate tests (see below)</div></div></div>';
			
			if(studyDesign.DVs.length > 0 && studyDesign.IVs.length > 0) {
				$.each(studyDesign.DVs, function(i) { 
					let testStr = "";   
					
					function generateAccordionHeader(i, name, statisticalTest, type) {
						return '<div class="accordion-item" id="accordion' + i +'"><button class="accordion-button collapsed " type="button" data-bs-toggle="collapse" data-bs-target="#collapse' + i +'" aria-controls="accordion' + i +'"><h6 class="accordion-header">' + getDataTypeIcon(type) + ' ' + studyDesign.DVs[i].name + ': ' + statisticalTest + '</h6></button><div id="collapse' + i +'" class="accordion-collapse collapse" aria-labelledby="panelsStayOpen-headingOne"><div class="accordion-body bg-light">';
					}
					
					function generateNormality(text, code, show) {
						if(show) return '<strong><div class="mt-3">Normality test:</div></strong><div>' + text + '<br /><code>' + code + '</code></div>';
						else return "";
					}
					
					function generateCode(title, text, code) {
						return '<strong><div class="mt-3">' + title + '</strong><br /></div><div>' + text + '<br /><code light-bg>' + code + '</code></div>';
					} 
					
					function generateAccordionFooter() {
						return '</div></div></div></div>';
					}
					
					function tabPills(id, question, title1, title2, tab1, tab2) {
						return '<div class="mt-3">' + question + '</div><ul class="nav nav-pills mb-3 mt-3" white" id="pills-tab-' + id + '" role="tablist"><li class="nav-item" role="presentation"><button class="nav-link active btn-light me-1" id="pills-' + title1 + '-tab-' + id + '" data-bs-toggle="pill" data-bs-target="#pills-' + title1 + '-' + id + '" type="button" role="tab" aria-controls="pills-' + title1 + '-' + id + '" aria-selected="true">' + title1 + '</button>   </li> <li class="nav-item" role="presentation"><button class="nav-link" id="pills-' + title2 + '-tab-' + id + '" data-bs-toggle="pill" data-bs-target="#pills-' + title2 + '-' + id + '" type="button" role="tab" aria-controls="pills-' + title2 + '-' + id + '" aria-selected="false">' + title2 + '</button>   </li></ul> <div class="tab-content" id="pills-tabContent"><div class="tab-pane fade show active" id="pills-' + title1 + '-' + id + '" role="tabpanel" aria-labelledby="pills-' + title1 + '-tab-' + id + '">' + tab1 + '</div>   <div class="tab-pane fade" id="pills-' + title2 + '-' + id + '" role="tabpanel" aria-labelledby="pills-' + title2 + '-tab-' + id + '">' + tab2 + '</div> </div>';
					}
					
					if(withinIVs.length >= 1 && betweenIVs.length >= 1) {  
						let parametricTestStr = generateCode('Your statistical test for parametric data', 'The test provided by the <code>rstatix</code>-package automatically applies Greenhouse-Geisser correction to your within-subjects IVs violating the sphericity assumption (when Mauchly\'s test p-value is significant, p &#8804; 0.05).','library(rstatix)<br />aov <- anova_test(data = data, dv = ' + studyDesign.DVs[i].name + ', wid = SubjectID,  between = c(' + getNamesFromArray(betweenIVs, ", ", "name").slice(0, -2) + '), within = c(' + getNamesFromArray(withinIVs, ", ", "name").slice(0, -2) + '))</br>get_anova_table(aov, correction = "auto")');
						parametricTestStr += generateCode('The post hoc test for parametric data', 'Post hoc tests of interaction effects can computed with the <code>testInteraction()</code> procedure of the <code>phia</code> package in R. Such results are difficult to interpret. With main effects only you can perform pairwise comparisons using t-tests, e.g.:','library(rstatix)<br />t_test(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + withinIVs[0].name + ')');
						parametricTestStr += generateCode('Evaluate your effect size','To determine your main and interaction effect size <i>partial eta-squared</i> of a multi-factorial ANOVA you can use the following interpretation: 0.01 - 0.01 (small effect), 0.01 - 0.06 (moderate effect) and 0.06 - 0.14 (large effect).','library(rstatix)<br />aov <- anova_test(data = data, dv = ' + studyDesign.DVs[i].name + ', wid = SubjectID,  between = c(' + getNamesFromArray(betweenIVs, ", ", "name").slice(0, -2) + '), within = c(' + getNamesFromArray(withinIVs, ", ", "name").slice(0, -2) + '))</br>get_anova_table(aov, correction = "auto")');
						
						let nonparametricTestStr = generateCode('Your statistical test for non-parametric data', 'The test by the <code>ARTool</code>-package performs a non-parametric ' + number2words(studyDesign.IVs.length) + '-factorial mixed-design ART-ANOVA.','library(ARTool)<br />art <- art(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + getNamesFromArray(studyDesign.IVs, " * ", "name").slice(0, -2) + ' + (1|SubjectID) )</br>anova(art)');	
						nonparametricTestStr += generateCode('The post hoc test for non-parametric data', 'Post hoc tests of interaction effects can computed with the <code>testInteraction()</code> procedure of the <code>phia</code> package in R. Such results are difficult to interpret. With main effects only you can perform pairwise comparisons using Wilcoxon signed-rank tests, e.g.:','library(rstatix)<br />wilcox_test(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + withinIVs[0].name + ', paired=TRUE)');	
						nonparametricTestStr += generateCode('Evaluate your effect size','Save your non-parametric ART-ANOVA model above. Add a new column with (SS/SS+SStotal) deriving your main and interaction effect size <i>partial eta-squared</i> and use the following interpretation: 0.01 - 0.01 (small effect), 0.01 - 0.06 (moderate effect) and 0.06 - 0.14 (large effect).','anova.art <- anova(art)<br />anova.art$eta.sq.part = anova.art$`Sum Sq`/(anova.art$`Sum Sq` + anova.art$`Sum Sq.res`)<br />anova.art');
						
						if(studyDesign.DVs[i].type == "R" || studyDesign.DVs[i].type == "I") {
							// mixed design ANOVA 
							resultStr += generateAccordionHeader(i, studyDesign.DVs[i].name, "a " + number2words(studyDesign.IVs.length) + "-factorial mixed-design ANOVA", studyDesign.DVs[i].type);
							resultStr += generateNormality('Your settings suggest that you can potentially apply parametric tests. Before doing so you must check your conditions for normal distribution using the test by Shapiro-Wilk.','library(rstatix)<br />library(tidyverse)<br />data %>% group_by(' + getNamesFromArray(nominalIVs, ", ", "name").slice(0, -2) + ') %>% shapiro_test(' + studyDesign.DVs[i].name + ')', true); 
							resultStr += (($("#samplesInputId").val() > 50) ? '<div class="mt-3">Your sample size is greater than 50. If any of the Shapiro-Wilk\'s tests is significant, your can also test your data using a normal QQ plot which draws a correlation between the given data and its normal distribution. If all points for each cell fall approximately along the reference line, you can assume normality of the data without Shapiro-Wilk\'s test. The plot can created using the <code>ggpubr</code> package.<br /> <code>library(ggpubr)<br />ggqqplot(data, "' + studyDesign.DVs[i].name + '", ggtheme = theme_bw()) + facet_grid(' + getNamesFromArray(withinIVs, " ~ ", "name").slice(0, -3).replace(/[\~\%]/g, function(match, offset, all) { return match === "~" ? (all.indexOf("~") === offset ? '~' : '+') : ''; })  + ')</code></div>' : '')							
							resultStr += tabPills(i, "Do the tests indicate that your data is normal distributed (all p&#8805; 0.05 for all conditions)?", "yes","no", parametricTestStr, nonparametricTestStr);	 	 					
						} else { // mixed-design ART ANOVA 
							resultStr += generateAccordionHeader(i, studyDesign.DVs[i].name, "a " + number2words(studyDesign.IVs.length) + "-factorial mixed-design aligned-rank transform (ART) ANOVA", studyDesign.DVs[i].type);
							resultStr += nonparametricTestStr;
						} 
					}
					if(withinIVs.length >= 1 && betweenIVs.length == 0 ) { 
						if((withinIVs.length > 1 || withinIVs[0].levels.length > 2) && studyDesign.nonOrdinalIVs.length == 0) {
							let parametricTestStr = "";
							let nonparametricTestStr = "";
							
							parametricTestStr += generateCode('Your statistical test for parametric data', 'The test provided by the <code>rstatix</code>-package automatically applies Greenhouse-Geisser correction to your within-subjects IVs violating the sphericity assumption (when Mauchly\'s test p-value is significant, p &#8804; 0.05).','library(rstatix)<br />aov <- anova_test(data = data, dv = ' + studyDesign.DVs[i].name + ', wid = SubjectID, within = c(' + getNamesFromArray(withinIVs, ", ", "name").slice(0, -2) + '))</br>get_anova_table(aov, correction = "auto")');
							parametricTestStr += generateCode('Your post hoc test for parametric data', 'Post hoc tests of interaction effects can computed with the <code>testInteraction()</code> procedure of the <code>phia</code> package in R. Such results are difficult to interpret. With main effects only you can perform pairwise comparisons using t-tests, e.g.:','library(rstatix)<br />t_test(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + withinIVs[0].name + ')');
							parametricTestStr += generateCode('Evaluate your effect size','To determine your main and interaction effect size <i>partial eta-squared</i> of a multi-factorial ANOVA you can use the following interpretation: 0.01 - 0.01 (small effect), 0.01 - 0.06 (moderate effect) and 0.06 - 0.14 (large effect).','library(rstatix)<br />aov <- anova_test(data = data, dv = ' + studyDesign.DVs[i].name + ', wid = SubjectID, within = c(' + getNamesFromArray(withinIVs, ", ", "name").slice(0, -2) + '), effect.size = "pes")</br>get_anova_table(aov, correction = "auto")');
							
							if(withinIVs.length > 1){
								nonparametricTestStr += generateCode('Your statistical test for non-parametric data', 'The test by the <code>ARTool</code>-package performs a non-parametric ' + number2words(studyDesign.IVs.length) + '-factorial mixed-design ART-ANOVA.','library(ARTool)<br />art <- art(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + getNamesFromArray(studyDesign.IVs, " * ", "name").slice(0, -2) + ' + (1|SubjectID) )</br>anova(art)');	
								nonparametricTestStr += generateCode('The post hoc test for non-parametric data', 'Post hoc tests of interaction effects can computed with the <code>testInteraction()</code> procedure of the <code>phia</code> package in R. Such results are difficult to interpret. With main effects only you can perform pairwise comparisons using Wilcoxon signed-rank tests, e.g.:','wilcox_test(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + withinIVs[0].name + ')');	
								nonparametricTestStr += generateCode('Evaluate your effect size','Save your non-parametric ART-ANOVA model above. Add a new column with (SS/SS+SStotal) deriving your main and interaction effect size <i>partial eta-squared</i> and use the following interpretation: 0.01 - 0.01 (small effect), 0.01 - 0.06 (moderate effect) and 0.06 - 0.14 (large effect).','anova.art <- anova(art)<br />anova.art$eta.sq.part = anova.art$`Sum Sq`/(anova.art$`Sum Sq` + anova.art$`Sum Sq.res`)<br />anova.art');
							} else {
								nonparametricTestStr += generateCode('Your statistical test for non-parametric data', 'The test performs a non-parametric Friedman rank sum test.','library(rstatix)<br />friedman_test(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + withinIVs[0].name + ' | SubjectID)'); 
								nonparametricTestStr += generateCode('Your post hoc test for parametric data', 'With significant main effect(s), you can perform pairwise comparisons using Wilcoxon signed-rank tests, e.g.:','library(rstatix)<br />wilcox_test(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + withinIVs[0].name + ', paired=TRUE)');  
								nonparametricTestStr += generateCode('Evaluate your effect size','To determine your main effect size <i>Kendall W</i> of a one-factorial non-parametric RM-ANOVA you can use the Cohen\'s interpretation guidelines of 0.1 - 0.3 (small effect), 0.3 - 0.5 (moderate effect) and >= 0.5 (large effect).','library(rstatix)<br />friedman_effsize(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + withinIVs[0].name + ' | SubjectID)');  
							}
							
							// RM ANOVAs
							if(studyDesign.DVs[i].type == "R" || studyDesign.DVs[i].type == "I") {
								// n-factorial ANOVA
								resultStr += generateAccordionHeader(i, studyDesign.DVs[i].name, "a " + number2words(studyDesign.IVs.length) + "-factorial repeated-measures (RM) ANOVA", studyDesign.DVs[i].type);
								resultStr += generateNormality('Your settings suggest that you can potentially apply parametric tests. Before doing so you must check your conditions for normal distribution using the test by Shapiro-Wilk.','library(rstatix)<br />library(tidyverse)<br />data %>% group_by(' + getNamesFromArray(nominalIVs, ", ", "name").slice(0, -2) + ') %>% shapiro_test(' + studyDesign.DVs[i].name + ')', true); 
								resultStr += (($("#samplesInputId").val() > 50) ? '<div class="mt-3">Your sample size is greater than 50. If any of the Shapiro-Wilk\'s tests is significant, your can also test your data using a normal QQ plot which draws a correlation between the given data and its normal distribution. If all points for each cell fall approximately along the reference line, you can assume normality of the data without Shapiro-Wilk\'s test. The plot can created using the <code>ggpubr</code> package.<br /> <code>library(ggpubr)<br />ggqqplot(data, "' + studyDesign.DVs[i].name + '", ggtheme = theme_bw()) + facet_grid(' + getNamesFromArray(withinIVs, " ~ ", "name").slice(0, -3).replace(/[\~\%]/g, function(match, offset, all) { return match === "~" ? (all.indexOf("~") === offset ? '~' : '+') : ''; })  + ')</code></div>' : '')							
								resultStr += tabPills(i, "Do the tests indicate that your data is normal distributed (all p&#8805; 0.05 for all conditions)?", "yes","no", parametricTestStr, nonparametricTestStr); 
							} else {
								if(studyDesign.IVs.length == 1){ // FRIEDMAN ANOVA
									resultStr += generateAccordionHeader(i, studyDesign.DVs[i].name, "a Friedman rank sum test (or non-parametric one-way repeated measures ANOVA)", studyDesign.DVs[i].type);
									resultStr += nonparametricTestStr;
								} else { 						 // ART ANOVA
									resultStr += generateAccordionHeader(i, studyDesign.DVs[i].name, "a " + number2words(studyDesign.IVs.length) + "-factorial aligned-rank transform (ART) repeated-measure (RM) ANOVA", studyDesign.DVs[i].type);
									resultStr += nonparametricTestStr;  
								}
							}
						} else { 
							let parametricTestStr = "";
							let nonparametricTestStr = "";
							
							if(withinIVs[0].levels.length == 2){  
								parametricTestStr += generateCode('Your statistical test for parametric data', 'Classic t-test between paired samples.','library(rstatix)<br />t_test(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + studyDesign.IVs[0].name + ', paired = TRUE)');
								parametricTestStr += generateCode('Evaluate your effect size', 'Effect sizes for paired (dependent) t-tests <i>d</i> poposed by Cohen, are: 0.1 - 0.2 (small effect), 0.2 - 0.5 (moderate effect) and 0.5 - 0.8 (large effect) (Cohen 1998, Navarro (2015)). This means that if two groups\' means don\'t differ by 0.2 standard deviations or more, the difference is trivial, even if it is statistically significant.','library(rstatix)<br />cohens_d(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + studyDesign.IVs[0].name + ', paired = TRUE)');
								
								let nonparametricTestStr = generateCode('Your statistical test for non-parametric data', 'A non-parametric test between two paired (dependent) samples.','library(rstatix)<br />wilcox_test(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + studyDesign.IVs[0].name + ', paired = TRUE)');  
								nonparametricTestStr += generateCode('Evaluate your effect size','The interpretation of the effect size of a non-parametric test between two paired (dependent) samples <i>r</i> is commonly: 0.1 - 0.3 (small effect), 0.3 - 0.5 (moderate effect) and > 0.5 (large effect).','library(rstatix)<br />wilcox_effsize(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + studyDesign.IVs[0].name + ', paired = TRUE)');
								
								if(studyDesign.DVs[i].type == "R" || studyDesign.DVs[i].type == "I") {  // paired t-test  
									resultStr += generateAccordionHeader(i, studyDesign.DVs[i].name, "an paired (dependent) t-test", studyDesign.DVs[i].type);
									resultStr += generateNormality('Your settings suggest that you can potentially apply parametric tests. Before doing so you must check your conditions for normal distribution using the test by Shapiro-Wilk.','library(rstatix)<br />library(tidyverse)<br />data %>% group_by(' + getNamesFromArray(nominalIVs, ", ", "name").slice(0, -2) + ') %>% shapiro_test(' + studyDesign.DVs[i].name + ')', true);  
									resultStr += tabPills(i, "Do the tests indicate that your data is normal distributed (all p&#8805; 0.05)?", "yes","no", parametricTestStr, nonparametricTestStr);  
								} else { 																// paired Wilcoxon-test  
									resultStr += generateAccordionHeader(i, studyDesign.DVs[i].name, "a paired Wilcoxon signed-rank test", studyDesign.DVs[i].type);
									resultStr += nonparametricTestStr
								}
							} else {
								let singleOrMultiples = studyDesign.nonOrdinalIVs.length > 1 ? "multivariate" : "single";
								let parametricTestStr = generateCode('Your statistical test for parametric data', 'A ' + singleOrMultiples + ' linear regression','lm <- lm(' + studyDesign.DVs[i].name + ' ~ ' + getNamesFromArray(withinIVs, " + ", "name").slice(0, -2) + ', data = data)</br>summary(lm)'); 
								
								let nonparametricTestStr = generateCode('Your statistical test for non-parametric data', 'A ' + singleOrMultiples + ' Kendall-Theil nonparametric regression using the <code>mblm</code> package','mblm <- mblm(' + studyDesign.DVs[i].name + ' ~ ' + getNamesFromArray(withinIVs, " + ", "name").slice(0, -2) + ', data = data)</br>summary(mblm)');  
								  
								if(studyDesign.DVs[i].type == "R" || studyDesign.DVs[i].type == "I") { 
									resultStr += generateAccordionHeader(i, studyDesign.DVs[i].name, "a " + singleOrMultiples + " linear regression", studyDesign.DVs[i].type);
									resultStr += generateNormality('Test your data using a normal QQ plot which draws a correlation between the given data and its normal distribution. If all points for each cell fall approximately along the reference line, you can assume normality. The plot can created using the <code>ggpubr</code> package.<br />', 'library(ggpubr)<br />ggqqplot(data, "' + studyDesign.DVs[i].name + '", ggtheme = theme_bw()) + facet_grid(' + getNamesFromArray(withinIVs, " ~ ", "name").slice(0, -3).replace(/[\~\%]/g, function(match, offset, all) { return match === "~" ? (all.indexOf("~") === offset ? '~' : '+') : ''; })  + ')', true); 
									resultStr += tabPills(i, "Do the tests indicate that your data is normal distributed?", "yes","no", parametricTestStr, nonparametricTestStr);  
								} else {
									resultStr += generateAccordionHeader(i, studyDesign.DVs[i].name, "a Kendall-Theil Sen Siegel nonparametric linear regression", studyDesign.DVs[i].type);
									resultStr += nonparametricTestStr
								} 
							}
						}
					}
					
					if(withinIVs.length == 0 && betweenIVs.length >= 1) { 
						if(betweenIVs.length > 1 || betweenIVs[0].levels.length > 2) {
							let parametricTestStr = generateCode('Your statistical test for parametric data', 'The test provided by the <code>rstatix</code>-package performs a multi-factorial ANOVA of independent samples','library(rstatix)<br />aov <- anova_test(data = data, dv = ' + studyDesign.DVs[i].name + ',  between = c(' + getNamesFromArray(betweenIVs, ", ", "name").slice(0, -2) + '))</br>get_anova_table(aov)'); 
							parametricTestStr += generateCode('Your post hoc test for parametric data', 'Post hoc tests of interaction effects can computed with the <code>testInteraction()</code> procedure of the <code>phia</code> package in R. Such results are difficult to interpret. With main effects only you can perform pairwise comparisons using t-tests, e.g.:','library(rstatix)<br />t_test(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + betweenIVs[0].name + ')');
							parametricTestStr += generateCode('Evaluate your effect size','To determine your main and interaction effect size <i>partial eta-squared</i> of a multi-factorial independent samples ANOVA you can use the following interpretation: 0.01 - 0.01 (small effect), 0.01 - 0.06 (moderate effect) and 0.06 - 0.14 (large effect).','library(rstatix)<br />aov <- anova_test(data = data, dv = ' + studyDesign.DVs[i].name + ', between = c(' + getNamesFromArray(betweenIVs, ", ", "name").slice(0, -2) + '), effect.size = "pes")</br>get_anova_table(aov)');
							
							let nonparametricTestStr = generateCode('Your statistical test for non-parametric data', 'The test by the <code>ARTool</code>-package performs a non-parametric ' + number2words(studyDesign.IVs.length) + '-factorial mixed-design ART-ANOVA.','library(ARTool)<br />art <- art(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + getNamesFromArray(studyDesign.IVs, " * ", "name").slice(0, -2) + '  )</br>anova(art)');
							nonparametricTestStr += generateCode('The post hoc test for non-parametric data', 'Post hoc tests of interaction effects can computed with the <code>testInteraction()</code> procedure of the <code>phia</code> package in R. Such results are difficult to interpret. With main effects only you can perform pairwise comparisons using Wilcoxon signed-rank tests, e.g.:','library(rstatix)<br />wilcox_test(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + betweenIVs[0].name + ')');	
							nonparametricTestStr += generateCode('Evaluate your effect size','Save your non-parametric ART-ANOVA model above. Add a new column with (SS/SS+SStotal) deriving your main and interaction effect size <i>partial eta-squared</i> and use the following interpretation: 0.01 - 0.01 (small effect), 0.01 - 0.06 (moderate effect) and 0.06 - 0.14 (large effect).','anova.art <- anova(art)<br />anova.art$eta.sq.part = anova.art$`Sum Sq`/(anova.art$`Sum Sq` + anova.art$`Sum Sq.res`)<br />anova.art');
 
							if(studyDesign.DVs[i].type == "R" || studyDesign.DVs[i].type == "I") { 
								// independent ANOVA 
								resultStr += generateAccordionHeader(i, studyDesign.DVs[i].name, "a " + number2words(studyDesign.IVs.length) + "-factorial independent samples ANOVA", studyDesign.DVs[i].type);
								resultStr += generateNormality('Your settings suggest that you can potentially apply parametric tests. Before doing so you must check your conditions for normal distribution using the test by Shapiro-Wilk.','library(rstatix)<br />library(tidyverse)<br />data %>% group_by(' + getNamesFromArray(nominalIVs, ", ", "name").slice(0, -2) + ') %>% shapiro_test(' + studyDesign.DVs[i].name + ')', true); 
								resultStr += (($("#samplesInputId").val() > 50) ? '<div class="mt-3">Your sample size is greater than 50. If any of the Shapiro-Wilk\'s tests is significant, your can also test your data using a normal QQ plot which draws a correlation between the given data and its normal distribution. If all points for each cell fall approximately along the reference line, you can assume normality of the data without Shapiro-Wilk\'s test. The plot can created using the <code>ggpubr</code> package.<br /> <code>library(ggpubr)<br />ggqqplot(data, "' + studyDesign.DVs[i].name + '", ggtheme = theme_bw()) + facet_grid(' + getNamesFromArray(withinIVs, " ~ ", "name").slice(0, -3).replace(/[\~\%]/g, function(match, offset, all) { return match === "~" ? (all.indexOf("~") === offset ? '~' : '+') : ''; })  + ')</code></div>' : '')							
								resultStr += tabPills(i, "Do the tests indicate that your data is normal distributed (all p&#8805; 0.05 for all conditions)?", "yes","no", parametricTestStr, nonparametricTestStr); 
							}  else {  
								// independent non-parametric (ART) ANOVA
								resultStr += generateAccordionHeader(i, studyDesign.DVs[i].name, "a " + number2words(studyDesign.IVs.length) + "-factorial aligned-rank transform (ART) ANOVA of independent samples", studyDesign.DVs[i].type);
								resultStr += nonparametricTestStr; 
							}
						}  else { // independent t-test 
							let parametricTestStr = generateCode('Your statistical test for parametric data', 'A classical t-test between two independent samples.','library(rstatix)<br />t_test(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + studyDesign.IVs[0].name + ', paired = FALSE)');	
							parametricTestStr += generateCode('Evaluate your effect size','Effect sizes for independent t-tests <i>d</i> poposed by Cohen, are: 0.1 - 0.2 (small effect), 0.2 - 0.5 (moderate effect) and 0.5 - 0.8 (large effect) (Cohen 1998, Navarro (2015)). This means that if two groups\' means don\'t differ by 0.2 standard deviations or more, the difference is trivial, even if it is statistically significant.','library(rstatix)<br />cohens_d(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + studyDesign.IVs[0].name + ', paired = FALSE)');
							
							let nonparametricTestStr = generateCode('Your statistical test for non-parametric data', 'A non-parametric test between two independent samples.','library(rstatix)<br />wilcox_test(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + studyDesign.IVs[0].name + ', paired = FALSE)');  
							nonparametricTestStr += generateCode('Evaluate your effect size','The interpretation of the effect size of a non-parametric test between two independent samples <i>r</i> is commonly: 0.1 - 0.3 (small effect), 0.3 - 0.5 (moderate effect) and > 0.5 (large effect).','library(rstatix)<br />wilcox_effsize(data = data, ' + studyDesign.DVs[i].name + ' ~ ' + studyDesign.IVs[0].name + ', paired = FALSE)');
							
							if(studyDesign.DVs[i].type == "R" || studyDesign.DVs[i].type == "I") {  
								resultStr += generateAccordionHeader(i, studyDesign.DVs[i].name, "an independent t-test", studyDesign.DVs[i].type);
								resultStr += generateNormality('Your settings suggest that you can potentially apply parametric tests. Before doing so you must check your conditions for normal distribution using the test by Shapiro-Wilk.','library(rstatix)<br />library(tidyverse)<br />data %>% group_by(' + getNamesFromArray(nominalIVs, ", ", "name").slice(0, -2) + ') %>% shapiro_test(' + studyDesign.DVs[i].name + ')', true); 
								resultStr += (($("#samplesInputId").val() > 50) ? '<div class="mt-3">Your sample size is greater than 50. If any of the Shapiro-Wilk\'s tests is significant, your can also test your data using a normal QQ plot which draws a correlation between the given data and its normal distribution. If all points for each cell fall approximately along the reference line, you can assume normality of the data without Shapiro-Wilk\'s test. The plot can created using the <code>ggpubr</code> package.<br /> <code>library(ggpubr)<br />ggqqplot(data, "' + studyDesign.DVs[i].name + '", ggtheme = theme_bw()) + facet_grid(' + getNamesFromArray(withinIVs, " ~ ", "name").slice(0, -3).replace(/[\~\%]/g, function(match, offset, all) { return match === "~" ? (all.indexOf("~") === offset ? '~' : '+') : ''; })  + ')</code></div>' : '') 
								resultStr += tabPills(i, "Do the tests indicate that your data is normal distributed (all p&#8805; 0.05 for all conditions)?", "yes","no", parametricTestStr, nonparametricTestStr);  
							} else {  // independent non-parametric test
								resultStr += generateAccordionHeader(i, studyDesign.DVs[i].name, "a Mann-Whitney U test (a.k.a. two-sample Wilcoxon test)", studyDesign.DVs[i].type);
								resultStr += nonparametricTestStr; 
							}
						}
					}
					resultStr += generateAccordionFooter();  
				});
			}
			$("#results").html("<div class='accordion'>" + resultStr + "</div>");
		} 
		
		function arrayToDesignSequence(array, type, num) {
			let str = '<div class="table-responsive"><table class="table" ">';
			str += '<thead><tr>';
			for(let i = 0; i < array.length; i++) {
				if(i == 0) str += '<th scope="col"><strong>Subject</strong></th>';
				if(array.length > 10) str += '<th scope="col"><strong>Cond. ' + (i + 1) + ' </strong></th>';
				if(array.length <= 10) str += '<th scope="col"><strong>Condition ' + (i + 1) + ' </strong></th>';
			}
			str += '</tr></thead><tbody>';
			
			if(type == "latinSquare"){
				let nb_rows = array.length;
				if (array.length % 2 != 0) nb_rows *= 2; 
				
				for(let n = 0; n < nb_rows; n++) {
					str += '<tr>';
					for(let i = 0; i < array.length; i++) {
						if(i == 0) str += '<th scope="row"><strong>' + (n + 1) + '</strong></th>';
						str += '<th><small>' + balancedLatinSquare(array, n)[i] + '</small></th>'; 
					} 
					str += '</tr>';
				}
			}
			
			if(type == "permutations"){
				for(let n = 0; n < permutations(array).length; n++) {
					str += '<tr>';
					for(let i = 0; i < array.length; i++) {
						if(i == 0) str += '<th scope="row"><strong>' + (n + 1) + '</strong></th>'; 
						str += '<th><small>' + permutations(array)[n][i] + '</small></th>'; 
					}
					str += '</tr>';
				} 
			}
			
			if(type == "shuffle"){
				for(let n = 0; n < num; n++) {
					str += '<tr>';
					for(let i = 0; i < array.length; i++) {
						if(i == 0) str += '<th scope="row"><strong>' + (n + 1) + '</strong></th>'; 
						str += '<th><small>' + shuffle(array, n)[i] + '</small></th>'; 
					}
					str += '</tr>';
				}
			}
			
			if(type == "between"){ 
				str += '<tr>';
				for(let i = 0; i < array.length; i++) {
					if(i == 0) str += '<th scope="row"><strong>Name</strong></th>'; 
					str += '<th><small>' + array[i] + '</small></th>'; 
				}
				str += '</tr>'; 
				for(let n = 1; n < 4; n++) {
					str += '<tr>';
					for(let i = 0; i < array.length; i++) {
						if(i == 0) str += '<th scope="row"><strong>Samples (N = ' + num * n + ')</strong></th>'; 
						str += '<th><small>' + num * n / array.length + ' subjects </small></th>'; 
					} 
					str += '</tr>'; 
				}
				str += '<tr>'; 
				for(let i = 0; i < array.length; i++) {
					if(i == 0) str += '<th scope="row"><strong>...</strong></th>'; 
					str += '<th><small>...</small></th>'; 
				}
				str += '</tr>'; 
				str += '<tr>'; 
				for(let i = 0; i < array.length; i++) {
					if(i == 0) str += '<th scope="row"><strong>Samples in %</strong></th>'; 
					str += '<th><small>' + ( 100 / array.length ) + '%</small></th>'; 
				}
				str += '</tr>'; 
			}
			str += '</tbody></table></div>';
			return str;
		}
		
		function getDataTypeIcon(val) {
			if(val == "N") return '<i class="bi bi-palette2 me-1"></i>';
			if(val == "O") return '<i class="bi bi-reception-4 me-1"></i>';
			if(val == "I") return '<i class="bi bi-rulers me-1"></i>';
			if(val == "R") return '<i class="bi bi-speedometer me-1"></i>'; 
			if(val == "M") return '<i class="bi bi-kanban me-1"></i>'; 
			if(val == "H") return '<i class="bi bi-filter-square-fill me-1"></i>'; 
		}
		
		function getNamesFromArray(array, separator, name) {
			let str = ""; 
			$.each(array, function(i){
				if(name != null) str += array[i][name];
				else str += array[i]; str += separator; 
			});
			return str;
		}
		
		function getItemsInArray(array, variable, name) {
			let filteredArray = [];
			$.each(array, function(i){ if(array[i][variable] == name) filteredArray.push(array[i]); });
			return filteredArray;
		}
		
		function setSlider(slider, label, val, min, max, steps) {
			$(slider).prop("step", steps);
			$(slider).prop("min", min);
			$(slider).prop("max", max);
			if(!manualSampleSizeUpdate) $(slider).val(val);
			if(!manualSampleSizeUpdate) $(label).val(val);  
			return $(slider).val();
		}

		function roundTo(value, digits) {
			let factor = Math.pow(10, digits);
			return Math.round(value * factor) / factor;
		}
		
		const calculateMean = (values) => {
			const mean = (values.reduce((sum, current) => sum + current)) / values.length;
			return mean;
		}; 

		const getVariance = (values) => {
			const average = calculateMean(values);
			const squareDiffs = values.map((value) => {
				const diff = value - average;
				return diff * diff;
			});
			const variance = calculateMean(squareDiffs);
			return variance;
		};
		
		const getSD = (variance) => {
			return Math.sqrt(variance);
		};
		
		function getHedgesG(delta, sd, N, corr) {   
			return (1 - getHedgesG(delta, sd, N)) / Math.sqrt(2 * ( 1 - corr)); 
		}
		
		function getCohensD(delta, sd) {    
			return delta / Math.sqrt((sd * sd + sd *sd)/2);
		} 
		
		function getCohensF(delta, sd) {   
			let d = getCohensD(delta, sd);
			return StudyPowerEngine.dToF(d); 
		} 
		
		function getPartialEtaSquared(delta, sd) { 
			let d = getCohensD(delta, sd); 
			return StudyPowerEngine.dToPartialEtaSquared(d);
		}
		
		function roundUpToNextDivisible(value, divisor) {
			if (divisor === 0) {
				return 'Divisor cannot be zero';
			}
			return Math.ceil(value / divisor) * divisor;
		}

		function estimateSampleSizeFor80PowerWithConditions(effectSize, numberOfConditions) { 
			const zAlpha = 1.96; // Z-score for 95% confidence
			const zBeta = 0.84; // Z-score for 80% power
			let sampleSizePerGroup = ((zAlpha + zBeta) ** 2) / (effectSize ** 2); 

			return roundUpToNextDivisible(sampleSizePerGroup, numberOfConditions); // Rounding up to the nearest whole number
		}
		
		function getHedgesG(delta, sd, N) {   
			pooledSD = Math.sqrt(((N - 1) * (sd * sd) + (N - 1) * (sd * sd)) / (N + N - 2));
			return delta / pooledSD;
		} 
		
		function getEffectSizef(delta, sd, N) {   
			let d = getHedgesG(delta, sd, N)
			return d / Math.sqrt(2); 
		}  
		
		function interpretCohensd(d) {  
			if (d < 0.2) {
				return 'negligible';
			} else if (d >= 0.2 && d < 0.5) {
				return 'small';
			} else if (d >= 0.5 && d < 0.8) {
				return 'medium';
			} else {
				return 'large';
			}
		} 
		
		function interpretCohensf(f) { 
			if (f < 0.1) {
				return 'negligible';
			} else if (f >= 0.1 && f < 0.25) {
				return 'small';
			} else if (f >= 0.25 && f < 0.4) {
				return 'medium';
			} else {
				return 'large';
			}
		}
		
		function interpretCohensPartialEtaSq(f) { 
			if (f < 0.1) {
				return 'negligible';
			} else if (f >= 0.1 && f < 0.25) {
				return 'small';
			} else if (f >= 0.25 && f < 0.4) {
				return 'medium';
			} else {
				return 'large';
			}
		}
		
		function interpretPartialEtaSquared(etaSquared) {  
			if (etaSquared < 0.01) {
				return 'negligble';
			} else if (etaSquared >= 0.01 && etaSquared < 0.06) {
				return 'small';
			} else if (etaSquared >= 0.06 && etaSquared < 0.14) {
				return 'medium';
			} else {
				return 'large';
			}
		}
		
		function roundUp(x,y) {
			return Math.ceil(x/y)*y;
		}
		
		function shuffle(array, seed) {
			Math.seedrandom(seed);
			let j, tmp;
			for (let i = array.length - 1; i > 0; i--) {
				j = Math.floor(Math.random() * (i + 1));
				tmp = array[i];
				array[i] = array[j];
				array[j] = tmp;
			}
			return array;
		}
		
		function permutations(xs, n) {
			let result = [];
			for (let i = 0; i < xs.length; i = i + 1) {
				let rest = permutations(xs.slice(0, i).concat(xs.slice(i + 1)));
				if(!rest.length) {
					result.push([xs[i]])
				} else {
					for(let j = 0; j < rest.length; j = j + 1) {
						result.push([xs[i]].concat(rest[j]))
					}
				}
			} 
			return result;
		} 
		
		function balancedLatinSquare(array, subjectId) {
			let result = []; 
			for (let i = 0, j = 0, h = 0; i < array.length; ++i) {
				let val = 0;
				if (i < 2 || i % 2 != 0) {
					val = j++;
				} else {
					val = array.length - h - 1;
					++h;
				}

				let idx = (val + subjectId) % array.length;
				result.push(array[idx]);
			}

			if (array.length % 2 != 0 && subjectId % 2 != 0) {
				result = result.reverse();
			}

			return result;
		}
 
		function example2x3Within(){  
			runExampleSetup(function() {
				$("input[name='nameIV']").val("Prototype");
				$("select[name='selectIVType'] option:eq(1)").prop("selected", true);
				$("select[name='selectIVwithin'] option:eq(1)").prop("selected", true);
				$("input[name='enterLevelsIV']").val("Prototype A, Prototype B");
				$("#addIV").click();
				$("input[name='nameIV']").val("Scenario");
				$("select[name='selectIVType'] option:eq(1)").prop("selected", true);
				$("select[name='selectIVwithin'] option:eq(1)").prop("selected", true);
				$("input[name='enterLevelsIV']").val("Scenario A, Scenario B, Scenario C");
				$("#addIV").click();
				$("input[name='nameDV']").val("Presence");
				$("select[name='selectDVType'] option:eq(4)").prop("selected", true);
				$("#addDV").click();
				$("input[name='nameDV']").val("Throughput");
				$("select[name='selectDVType'] option:eq(4)").prop("selected", true);
				$("#addDV").click();
				$("input[name='nameDV']").val("Clicks");
				$("select[name='selectDVType'] option:eq(2)").prop("selected", true);
				$("#addDV").click();
				$("input[name='nameDV']").val("Distance");
				$("select[name='selectDVType'] option:eq(3)").prop("selected", true);
				$("#addDV").click();
			});
		}
 
		function example2x4Mixed(){  
			runExampleSetup(function() {
				$("input[name='nameIV']").val("Gender");
				$("select[name='selectIVType'] option:eq(1)").prop("selected", true);
				$("select[name='selectIVwithin'] option:eq(2)").prop("selected", true);
				$("input[name='enterLevelsIV']").val("men, women");
				$("#addIV").click();
				$("input[name='nameIV']").val("Prototype");
				$("select[name='selectIVType'] option:eq(1)").prop("selected", true);
				$("select[name='selectIVwithin'] option:eq(1)").prop("selected", true);
				$("input[name='enterLevelsIV']").val("Prototype A, Prototype B, Prototype C, Prototype D");
				$("#addIV").click();
				$("input[name='nameDV']").val("Words per Minute");
				$("select[name='selectDVType'] option:eq(4)").prop("selected", true);
				$("#addDV").click();
				$("input[name='nameDV']").val("Characters per Minute");
				$("select[name='selectDVType'] option:eq(4)").prop("selected", true);
				$("#addDV").click();
				$("input[name='nameDV']").val("Correct Answers");
				$("select[name='selectDVType'] option:eq(2)").prop("selected", true);
				$("#addDV").click();
			});
		}
 
		function exampleRegression(){  
			runExampleSetup(function() {
				$("input[name='nameIV']").val("Volume");
				$("select[name='selectIVType'] option:eq(4)").prop("selected", true);
				$("select[name='selectIVwithin'] option:eq(1)").prop("selected", true);
				$("#addIV").click();
				$("input[name='nameIV']").val("Workload");
				$("select[name='selectIVType'] option:eq(4)").prop("selected", true);
				$("select[name='selectIVwithin'] option:eq(1)").prop("selected", true);
				$("#addIV").click();
				$("input[name='nameDV']").val("Words per Minute");
				$("select[name='selectDVType'] option:eq(4)").prop("selected", true);
				$("#addDV").click();
				$("input[name='nameDV']").val("Characters per Minute");
				$("select[name='selectDVType'] option:eq(4)").prop("selected", true);
				$("#addDV").click();
			});
		}
		
		function generate() { }

		window.generate = generate;

		function number2words(n){
			let num = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
			let tens = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
			if (n < 20) return num[n];
			let digit = n%10;
			if (n < 100) return tens[~~(n/10)-2] + (digit? "-" + num[digit]: "");
			if (n < 1000) return num[~~(n/100)] +" hundred" + (n%100 == 0? "": " and " + number2words(n%100));
			return number2words(~~(n/1000)) + " thousand" + (n%1000 != 0? " " + number2words(n%1000): "");
		}
		
		function combineArrays( array_of_arrays ){ 
			if(!array_of_arrays) return [];
			if(!Array.isArray(array_of_arrays)) return [];
			if( array_of_arrays.length == 0 ) return [];

			for(let i = 0; i < array_of_arrays.length; i++ ){
				if(!Array.isArray(array_of_arrays[i]) || array_of_arrays[i].length == 0 ) return []; 
			}
  
			let combinationLimit = array_of_arrays.reduce(function(total, values) {
				return total * values.length;
			}, 1);
			let odometer = new Array( array_of_arrays.length );
			odometer.fill(0);  
			let output = [];
			let newCombination = formCombination( odometer, array_of_arrays );
			output.push( newCombination );
			let safetyCounter = 1;

			while ( odometer_increment( odometer, array_of_arrays ) && safetyCounter < combinationLimit ){
				newCombination = formCombination( odometer, array_of_arrays );
				output.push( newCombination );
				safetyCounter++;
			}

			return output;
		}
		
		function onlyUniqueValuesInArray(value, index, self) {
			return self.indexOf(value) === index;
		}

 
		function formCombination( odometer, array_of_arrays ){ 
			return odometer.reduce(
			function(accumulator, odometer_value, odometer_index){
				return "" + accumulator + array_of_arrays[odometer_index][odometer_value] + "-";
			}, "");
		}

		function odometer_increment( odometer, array_of_arrays ){
			for( let i_odometer_digit = odometer.length-1; i_odometer_digit >=0; i_odometer_digit-- ){ 
				let maxee = array_of_arrays[i_odometer_digit].length - 1;         
				if( odometer[i_odometer_digit] + 1 <= maxee ){
					odometer[i_odometer_digit]++;
					return true;
				} else{
					if( i_odometer_digit - 1 < 0 ){	return false;}
					else{
						odometer[i_odometer_digit]=0;
						continue;
					}
				}
			}
		}

		function destroyPowerChart() {
			if(powerChartInstance) {
				powerChartInstance.destroy();
				powerChartInstance = null;
			}
		}

		function dedupeAndSortCurvePoints(curvePoints) {
			let pointMap = new Map();

			(curvePoints || []).forEach(function(point) {
				if(!point || !isFinite(point.totalParticipants)) {
					return;
				}

				pointMap.set(Number(point.totalParticipants), point);
			});

			return Array.from(pointMap.values()).sort(function(left, right) {
				return left.totalParticipants - right.totalParticipants;
			});
		}

		function buildConsistentCurvePoints(curvePoints, requiredN, requiredRows) {
			let points = (curvePoints || []).slice();

			// Keep the analytical curve intact, but ensure the currently reported
			// Required N is present as an explicit point so the reference line and
			// tooltip logic can align with the table below.
			if(isFinite(requiredN) && Array.isArray(requiredRows) && requiredRows.length > 0) {
				points.push({
					totalParticipants: Number(requiredN),
					rows: requiredRows
				});
			}

			return dedupeAndSortCurvePoints(points);
		}

		function getChartTickStep(values) {
			if(!values || values.length <= 1) {
				return 1;
			}

			let minStep = null;

			for(let i = 1; i < values.length; i++) {
				let step = values[i] - values[i - 1];

				if(step > 0 && (minStep === null || step < minStep)) {
					minStep = step;
				}
			}

			return minStep || 1;
		}

		function createLegendLineSymbol(color, dashPattern, vertical) {
			let symbolCanvas = document.createElement("canvas");
			symbolCanvas.width = 18;
			symbolCanvas.height = 18;
			let symbolContext = symbolCanvas.getContext("2d");

			if(!symbolContext) {
				return symbolCanvas;
			}

			symbolContext.strokeStyle = color;
			symbolContext.lineWidth = 2;
			symbolContext.setLineDash(dashPattern || []);
			symbolContext.lineCap = "round";
			symbolContext.beginPath();

			if(vertical) {
				symbolContext.moveTo(9, 2);
				symbolContext.lineTo(9, 16);
			} else {
				symbolContext.moveTo(2, 9);
				symbolContext.lineTo(16, 9);
			}

			symbolContext.stroke();
			return symbolCanvas;
		}

		function createLegendSquareSymbol(fillColor, strokeColor) {
			let symbolCanvas = document.createElement("canvas");
			symbolCanvas.width = 18;
			symbolCanvas.height = 18;
			let symbolContext = symbolCanvas.getContext("2d");

			if(!symbolContext) {
				return symbolCanvas;
			}

			symbolContext.fillStyle = fillColor;
			symbolContext.strokeStyle = strokeColor || fillColor;
			symbolContext.lineWidth = 1;
			symbolContext.beginPath();
			symbolContext.rect(3, 3, 12, 12);
			symbolContext.fill();
			symbolContext.stroke();
			return symbolCanvas;
		}

		function renderPowerChart(canvasId, curvePoints, highlightedN, highlightedPower, requiredN, targetPower) {
			let canvas = document.getElementById(canvasId);
			let context = null;

			if(!canvas || typeof canvas.getContext !== "function") {
				return;
			}

			try {
				context = canvas.getContext("2d");
			} catch (error) {
				console.warn("Chart rendering skipped:", error);
				return;
			}

			if(!context) {
				return;
			}

			let normalizedCurvePoints = dedupeAndSortCurvePoints(curvePoints);
			let labels = normalizedCurvePoints.map(function(point) { return point.totalParticipants; });
			let tickStepSize = getChartTickStep(labels);
			let effectLabels = [];
			let targetY = roundTo(targetPower * 100, 1);
			let highlightedY = isFinite(highlightedPower) ? roundTo(highlightedPower * 100, 1) : null;
			let minX = labels.length ? Math.min.apply(null, labels.concat([highlightedN, requiredN].filter(isFinite))) : Math.min(highlightedN || 0, requiredN || 0);
			let maxX = labels.length ? Math.max.apply(null, labels.concat([highlightedN, requiredN].filter(isFinite))) : Math.max(highlightedN || 1, requiredN || 1);

			$(normalizedCurvePoints).each(function(_, point) {
				$(point.rows).each(function(__, row) {
					if(effectLabels.indexOf(row.label) === -1) {
						effectLabels.push(row.label);
					}
				});
			});

			let palette = ["#0d6efd", "#198754", "#dc3545", "#fd7e14", "#6f42c1", "#20c997"];
			let datasets = effectLabels.map(function(label, index) {
				return {
					label: label,
					data: normalizedCurvePoints.map(function(point) {
						let match = point.rows.find(function(row) { return row.label === label; });
						return match ? { x: point.totalParticipants, y: roundTo(match.power * 100, 1) } : null;
					}),
					borderColor: palette[index % palette.length],
					backgroundColor: palette[index % palette.length],
					tension: 0.25,
					fill: false,
					pointRadius: 2,
					pointHoverRadius: 4
				};
			});

			datasets.push({
				label: "Target power",
				data: [{ x: minX, y: targetY }, { x: maxX, y: targetY }],
				borderColor: "#111827",
				borderDash: [6, 4],
				pointRadius: 0,
				tension: 0,
				fill: false
			});

			datasets.push({
				label: "Minimum N",
				data: isFinite(highlightedN) && isFinite(highlightedY) ? [{ x: highlightedN, y: highlightedY }] : [],
				borderColor: "#111827",
				backgroundColor: "#111827",
				showLine: false,
				pointRadius: 6,
				pointHoverRadius: 7
			});

			datasets.push({
				label: "Required N",
				data: isFinite(requiredN) ? [{ x: requiredN, y: 0 }, { x: requiredN, y: 100 }] : [],
				borderColor: "#c2410c",
				backgroundColor: "#c2410c",
				borderDash: [4, 4],
				pointRadius: 0,
				pointHoverRadius: 0,
				tension: 0
			});

			destroyPowerChart();
			powerChartInstance = new Chart(context, {
				type: "line",
				data: {
					datasets: datasets
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					interaction: {
						mode: "nearest",
						intersect: false
					},
					plugins: {
						legend: {
							labels: {
								usePointStyle: true,
								pointStyleWidth: 18,
								generateLabels: function(chart) {
									// Chart.js uses generic legend markers by default.
									// We override them here so the legend matches the
									// actual plot semantics: effect curves, target line,
									// minimum point, and required vertical line.
									let defaultLabels = Chart.defaults.plugins.legend.labels.generateLabels(chart);

									return defaultLabels.map(function(label) {
										if(label.text === "Target power") {
											label.pointStyle = createLegendLineSymbol("#111827", [6, 4], false);
										} else if(label.text === "Required N") {
											label.pointStyle = createLegendLineSymbol("#c2410c", [4, 4], true);
										} else if(label.text === "Minimum N") {
											label.pointStyle = "circle";
											label.fillStyle = "#111827";
											label.strokeStyle = "#111827";
										} else {
											label.pointStyle = createLegendSquareSymbol(label.fillStyle || label.strokeStyle || "#0d6efd", label.strokeStyle || label.fillStyle || "#0d6efd");
										}

										return label;
									});
								}
							}
						}
					},
					scales: {
						y: {
							min: 0,
							max: 100,
							title: {
								display: true,
								text: "Power (%)"
							}
						},
						x: {
							type: "linear",
							title: {
								display: true,
								text: "Total participants"
							},
							ticks: {
								stepSize: tickStepSize,
								precision: 0
							}
						}
					}
				}
			});
		}

		function buildAnovaPowerFormula(effectRow, selectedParticipants) {
			let safeLambda = Number.isFinite(effectRow.lambda) ? effectRow.lambda : 0;
			let safeF = Number.isFinite(effectRow.cohenF) ? effectRow.cohenF : 0;
			let safeFSquared = safeF * safeF;
			let lambdaWeight = safeFSquared > 0 && selectedParticipants > 0 ? safeLambda / (selectedParticipants * safeFSquared) : 0;
			return '<div class="formula-stack">' +
				'<p>This result is based on the controlling ANOVA effect <strong>' + effectRow.label + '</strong> (' + (effectRow.effectType || "ANOVA effect") + ').</p>' +
				'<math display="block"><mrow><mi>Power</mi><mo>=</mo><mn>1</mn><mo>-</mo><msub><mi>F</mi><mi>ncf</mi></msub><mo>(</mo><msub><mi>F</mi><mi>crit</mi></msub><mo>;</mo><mi>df</mi><mn>1</mn><mo>=</mo><mn>' + effectRow.df1 + '</mn><mo>,</mo><mi>df</mi><mn>2</mn><mo>=</mo><mn>' + effectRow.df2 + '</mn><mo>,</mo><mi>&lambda;</mi><mo>=</mo><mn>' + roundTo(safeLambda, 3) + '</mn><mo>)</mo></mrow></math>' +
				'<math display="block"><mrow><mi>&lambda;</mi><mo>=</mo><mi>N</mi><mo>&times;</mo><msup><mi>f</mi><mn>2</mn></msup><mo>&times;</mo><mi>w</mi><mo>=</mo><mn>' + selectedParticipants + '</mn><mo>&times;</mo><mn>' + roundTo(safeFSquared, 3) + '</mn><mo>&times;</mo><mn>' + roundTo(lambdaWeight, 3) + '</mn></mrow></math>' +
				'<p><strong>Step 1.</strong> The current participant count is <strong>N = ' + selectedParticipants + '</strong>.</p>' +
				'<p><strong>Step 2.</strong> The selected omnibus effect size is <strong>f = ' + roundTo(effectRow.cohenF, 3) + '</strong>, therefore <strong>f² = ' + roundTo(effectRow.cohenF * effectRow.cohenF, 3) + '</strong>.</p>' +
				'<p><strong>Step 3.</strong> The model-specific weight is <strong>w = ' + roundTo(lambdaWeight, 3) + '</strong>, which leads to <strong>&lambda; = ' + roundTo(safeLambda, 3) + '</strong>.</p>' +
				'<p><strong>Step 4.</strong> With <strong>df1 = ' + effectRow.df1 + '</strong> and <strong>df2 = ' + effectRow.df2 + '</strong>, the noncentral F distribution yields the reported power for this specific ANOVA effect.</p>' +
				'</div>';
		}

		function buildRegressionFormula(regressionResult, selectedParticipants) {
			let fSquaredRow = regressionResult.tableRows.find(function(row) { return row.label === "Effect size (f²)"; });
			let fSquared = fSquaredRow ? parseFloat(fSquaredRow.value) : 0;
			let predictorsRow = regressionResult.tableRows.find(function(row) { return row.label === "Predictors"; });
			let numeratorDfRow = regressionResult.tableRows.find(function(row) { return row.label === "Numerator df (u)"; });
			let denominatorDfRow = regressionResult.tableRows.find(function(row) { return row.label === "Denominator df (v)"; });
			return '<div class="formula-stack">' +
				'<p>This result is based on the overall multiple regression model.</p>' +
				'<math display="block"><mrow><mi>Power</mi><mo>=</mo><mn>1</mn><mo>-</mo><msub><mi>F</mi><mi>ncf</mi></msub><mo>(</mo><msub><mi>F</mi><mi>crit</mi></msub><mo>;</mo><mi>u</mi><mo>=</mo><mn>' + (numeratorDfRow ? numeratorDfRow.value : "?") + '</mn><mo>,</mo><mi>v</mi><mo>=</mo><mn>' + (denominatorDfRow ? denominatorDfRow.value : "?") + '</mn><mo>,</mo><mi>&lambda;</mi><mo>=</mo><mn>' + roundTo(selectedParticipants * fSquared, 3) + '</mn><mo>)</mo></mrow></math>' +
				'<math display="block"><mrow><mi>&lambda;</mi><mo>=</mo><mi>N</mi><mo>&times;</mo><msup><mi>f</mi><mn>2</mn></msup><mo>=</mo><mn>' + selectedParticipants + '</mn><mo>&times;</mo><mn>' + roundTo(fSquared, 3) + '</mn><mo>=</mo><mn>' + roundTo(selectedParticipants * fSquared, 3) + '</mn></mrow></math>' +
				'<p><strong>Step 1.</strong> The model contains <strong>' + (predictorsRow ? predictorsRow.value : "?") + '</strong> predictor(s).</p>' +
				'<p><strong>Step 2.</strong> The expected regression effect is <strong>f² = ' + roundTo(fSquared, 3) + '</strong>.</p>' +
				'<p><strong>Step 3.</strong> With <strong>N = ' + selectedParticipants + '</strong>, this gives <strong>&lambda; = ' + roundTo(selectedParticipants * fSquared, 3) + '</strong>.</p>' +
				'<p><strong>Step 4.</strong> The F test then uses <strong>u = ' + (numeratorDfRow ? numeratorDfRow.value : "?") + '</strong> and <strong>v = ' + (denominatorDfRow ? denominatorDfRow.value : "?") + '</strong> to compute the final power.</p>' +
				'</div>';
		}

		function buildTTestFormula(selectedResult) {
			let isPaired = studyDesign.withinIVs.length > 0;
			let criticalT = Number.isFinite(selectedResult.criticalT) ? selectedResult.criticalT : 0;
			let delta = Number.isFinite(selectedResult.delta) ? selectedResult.delta : 0;
			let df = selectedResult.df2;
			let cohenD = Number.isFinite(selectedResult.cohenD) ? selectedResult.cohenD : 0;
			let cohenDz = Number.isFinite(selectedResult.cohenDz) ? selectedResult.cohenDz : cohenD;
			let sampleSize = selectedResult.sampleSize || 0;
			let perGroup = selectedResult.groupSampleSize || Math.max(1, Math.round(sampleSize / 2));

			if(isPaired) {
				return '<div class="formula-stack">' +
					'<p>This result is based on the paired two-tailed t-test for matched observations.</p>' +
					'<math display="block"><mrow><mi>df</mi><mo>=</mo><mi>N</mi><mo>-</mo><mn>1</mn><mo>=</mo><mn>' + sampleSize + '</mn><mo>-</mo><mn>1</mn><mo>=</mo><mn>' + df + '</mn></mrow></math>' +
					'<math display="block"><mrow><mi>&delta;</mi><mo>=</mo><msub><mi>d</mi><mi>z</mi></msub><mo>&times;</mo><msqrt><mi>N</mi></msqrt><mo>=</mo><mn>' + roundTo(cohenDz, 3) + '</mn><mo>&times;</mo><msqrt><mn>' + sampleSize + '</mn></msqrt><mo>=</mo><mn>' + roundTo(delta, 3) + '</mn></mrow></math>' +
					'<math display="block"><mrow><msub><mi>t</mi><mi>crit</mi></msub><mo>=</mo><msup><mi>t</mi><mrow><mo>-</mo><mn>1</mn></mrow></msup><mo>(</mo><mn>1</mn><mo>-</mo><mi>&alpha;</mi><mo>/</mo><mn>2</mn><mo>,</mo><mi>df</mi><mo>)</mo><mo>=</mo><mn>' + roundTo(criticalT, 6) + '</mn></mrow></math>' +
					'<math display="block"><mrow><mi>Power</mi><mo>=</mo><mi>P</mi><mo>(</mo><mo>|</mo><mi>T</mi><mo>|</mo><mo>&gt;</mo><msub><mi>t</mi><mi>crit</mi></msub><mo>)</mo><mo>,</mo><mspace width="0.4em"></mspace><mi>T</mi><mo>&#x223C;</mo><mi>t</mi><mo>(</mo><mi>df</mi><mo>=</mo><mn>' + df + '</mn><mo>,</mo><mi>&delta;</mi><mo>=</mo><mn>' + roundTo(delta, 3) + '</mn><mo>)</mo></mrow></math>' +
					'<p><strong>Step 1.</strong> The standardized paired effect is entered as <strong>d = ' + roundTo(cohenD, 3) + '</strong>. For the matched-pairs test this is converted to <strong>d<sub>z</sub> = ' + roundTo(cohenDz, 3) + '</strong> using the fixed repeated-measures correlation.</p>' +
					'<p><strong>Step 2.</strong> With <strong>N = ' + sampleSize + '</strong> pairs, the noncentrality parameter becomes <strong>&delta; = ' + roundTo(delta, 3) + '</strong>.</p>' +
					'<p><strong>Step 3.</strong> The two-tailed critical value is <strong>t<sub>crit</sub> = ' + roundTo(criticalT, 6) + '</strong> for <strong>df = ' + df + '</strong>.</p>' +
					'<p><strong>Step 4.</strong> The reported power is the probability that the noncentral t distribution exceeds <strong>&plusmn;t<sub>crit</sub></strong>.</p>' +
					'</div>';
			}

			return '<div class="formula-stack">' +
				'<p>This result is based on the independent two-tailed t-test with equal group sizes.</p>' +
				'<math display="block"><mrow><mi>df</mi><mo>=</mo><mn>2</mn><mi>n</mi><mo>-</mo><mn>2</mn><mo>=</mo><mn>2</mn><mo>&times;</mo><mn>' + perGroup + '</mn><mo>-</mo><mn>2</mn><mo>=</mo><mn>' + df + '</mn></mrow></math>' +
				'<math display="block"><mrow><mi>&delta;</mi><mo>=</mo><mi>d</mi><mo>&times;</mo><msqrt><mfrac><mi>n</mi><mn>2</mn></mfrac></msqrt><mo>=</mo><mn>' + roundTo(cohenD, 3) + '</mn><mo>&times;</mo><msqrt><mfrac><mn>' + perGroup + '</mn><mn>2</mn></mfrac></msqrt><mo>=</mo><mn>' + roundTo(delta, 3) + '</mn></mrow></math>' +
				'<math display="block"><mrow><msub><mi>t</mi><mi>crit</mi></msub><mo>=</mo><msup><mi>t</mi><mrow><mo>-</mo><mn>1</mn></mrow></msup><mo>(</mo><mn>1</mn><mo>-</mo><mi>&alpha;</mi><mo>/</mo><mn>2</mn><mo>,</mo><mi>df</mi><mo>)</mo><mo>=</mo><mn>' + roundTo(criticalT, 6) + '</mn></mrow></math>' +
				'<math display="block"><mrow><mi>Power</mi><mo>=</mo><mi>P</mi><mo>(</mo><mo>|</mo><mi>T</mi><mo>|</mo><mo>&gt;</mo><msub><mi>t</mi><mi>crit</mi></msub><mo>)</mo><mo>,</mo><mspace width="0.4em"></mspace><mi>T</mi><mo>&#x223C;</mo><mi>t</mi><mo>(</mo><mi>df</mi><mo>=</mo><mn>' + df + '</mn><mo>,</mo><mi>&delta;</mi><mo>=</mo><mn>' + roundTo(delta, 3) + '</mn><mo>)</mo></mrow></math>' +
				'<p><strong>Step 1.</strong> The standardized difference is entered as <strong>d = ' + roundTo(cohenD, 3) + '</strong>.</p>' +
				'<p><strong>Step 2.</strong> With equal group sizes of <strong>n = ' + perGroup + '</strong> per group, the noncentrality parameter becomes <strong>&delta; = ' + roundTo(delta, 3) + '</strong>.</p>' +
				'<p><strong>Step 3.</strong> The two-tailed critical value is <strong>t<sub>crit</sub> = ' + roundTo(criticalT, 6) + '</strong> for <strong>df = ' + df + '</strong>.</p>' +
				'<p><strong>Step 4.</strong> The reported power is the probability that the noncentral t distribution exceeds <strong>&plusmn;t<sub>crit</sub></strong>.</p>' +
				'</div>';
		}

		function buildConditionCombinations(factors) {
			let safeFactors = (factors || []).filter(function(factor) {
				return factor && Array.isArray(factor.levels) && factor.levels.length > 0;
			});
			let combinations = [{}];
			let safetyCounter = 0;
			let maxCombinations = 64;

			safeFactors.forEach(function(factor) {
				let next = [];

				factor.levels.forEach(function(level) {
					combinations.forEach(function(existing) {
						if(safetyCounter >= maxCombinations) {
							return;
						}

						let expanded = Object.assign({}, existing);
						expanded[factor.name] = level;
						next.push(expanded);
						safetyCounter++;
					});
				});

				combinations = next.length ? next : combinations;
			});

			return combinations.slice(0, maxCombinations);
		}

		function buildPlaceholderObservationRows() {
			let rows = [];
			let betweenCombinations = buildConditionCombinations(studyDesign.betweenIVs);
			let withinCombinations = buildConditionCombinations(studyDesign.withinIVs);
			let dvs = studyDesign.DVs || [];
			let subjectId = 1;
			let maxSubjects = Math.max(6, betweenCombinations.length || 0);

			if(!betweenCombinations.length) {
				betweenCombinations = [{}];
			}

			if(!withinCombinations.length) {
				withinCombinations = [{}];
			}

			if(hasNominalFactors()) {
				betweenCombinations.forEach(function(betweenCondition) {
					let rowOffset = 0;

					if(subjectId > maxSubjects) {
						return;
					}

					withinCombinations.forEach(function(withinCondition) {
						let rowCells = ['<td>' + subjectId + '</td>'];

						studyDesign.IVs.forEach(function(iv, ivIndex) {
							let value = "";

							if(Object.prototype.hasOwnProperty.call(betweenCondition, iv.name)) {
								value = betweenCondition[iv.name];
							} else if(Object.prototype.hasOwnProperty.call(withinCondition, iv.name)) {
								value = withinCondition[iv.name];
							} else if(iv.type !== "N") {
								value = 20 + (subjectId * 3) + ivIndex;
							}

							rowCells.push('<td>' + value + '</td>');
						});

						dvs.forEach(function(dv, dvIndex) {
							rowCells.push('<td>' + roundTo(60 + (subjectId * 4.5) + rowOffset + (dvIndex * 2), 1) + '</td>');
						});

						rows.push("<tr>" + rowCells.join("") + "</tr>");
						rowOffset++;
					});

					subjectId++;
				});
			} else {
				for(let rowIndex = 1; rowIndex <= 4; rowIndex++) {
					let rowCells = ['<td>' + rowIndex + '</td>'];

					studyDesign.IVs.forEach(function(iv, ivIndex) {
						rowCells.push('<td>' + (20 + rowIndex * 5 + ivIndex * 3) + '</td>');
					});

					dvs.forEach(function(dv, dvIndex) {
						rowCells.push('<td>' + roundTo(55 + rowIndex * 4.2 + dvIndex * 2.3, 1) + '</td>');
					});

					rows.push("<tr>" + rowCells.join("") + "</tr>");
				}
			}

			return rows;
		}

		function buildPlaceholderDataTab() {
			let headers = ["<th>SubjectID</th>"];
			let rows = buildPlaceholderObservationRows();

			studyDesign.IVs.forEach(function(iv) {
				headers.push("<th>" + iv.name + "</th>");
			});

			if(studyDesign.DVs.length > 0) {
				studyDesign.DVs.forEach(function(dv) {
					headers.push("<th>" + dv.name + "</th>");
				});
			} else {
				headers.push("<th>Outcome</th>");
			}

			return '<p>Use one row per observation. For repeated-measures designs, the same <code>SubjectID</code> appears in multiple rows, once for each user-defined within-condition combination.</p>' +
				'<div class="table-responsive"><table class="table table-striped table-bordered"><thead><tr>' + headers.join("") + '</tr></thead><tbody>' + rows.join("") + '</tbody></table></div>' +
				'<div class="mt-3"></div>' +
				'<p><strong>Formatting rule:</strong> each IV gets its own column, each DV gets its own column, and every within-subject condition combination appears as a separate row for the same <code>SubjectID</code>.</p>';
		}

		function buildPowerSummary(minimumN, requiredN, controllingLabel, targetPower) {
			let targetPowerPercent = roundTo(normalizeTargetPowerValue(targetPower || 0.8) * 100, 0);
			return "<p><strong>Minimum N:</strong> " + minimumN + " participants to reach the target power of " + targetPowerPercent + "%.</p><p><strong>Required N:</strong> " + requiredN + " participants after rounding to the current design sequence multiple.</p><p><strong>Controlling effect:</strong> " + controllingLabel + " (selected with the radio buttons below).</p>";
		}

		function getNominalStepSize() {
			return Math.max(1, studyDesign.betweenConditions && studyDesign.betweenConditions.length ? studyDesign.betweenConditions.length : 1);
		}

		function getRequiredSampleSizeForCurrentDesign(minimumN) {
			return roundUpToNextDivisible(Math.max(0, parseInt(minimumN, 10) || 0), getDesignAlignmentMultiple());
		}

		function formatAnovaEffectType(effectType) {
			if(effectType === "mixed interaction" || effectType === "within interaction" || effectType === "between interaction") {
				return "Interaction";
			}

			if(effectType === "within") {
				return "Within";
			}

			if(effectType === "between") {
				return "Between";
			}

			return "Effect";
		}

		function normalizeTargetPowerValue(powerValue) {
			return Math.min(0.99, Math.max(0.5, Number(powerValue) || 0.8));
		}

		function findAnovaEffectRowAtSampleSize(effectLabel, participants, cohensF) {
			let result = StudyPowerEngine.estimateAnovaPower({
				factors: getNominalFactors(),
				effectSizeF: cohensF,
				alpha: 0.05,
				totalParticipants: participants,
				withinCorrelation: getCurrentWithinCorrelation()
			});

			return result.rows.find(function(row) {
				return row._row === effectLabel;
			}) || null;
		}

		function estimateMinimumForAnovaEffect(effectLabel, targetPower, cohensF) {
			let stepSize = getNominalStepSize();
			let minimumFloor = Math.max(stepSize * 2, stepSize);
			let sampleSizeCandidate = minimumFloor;
			let maxParticipants = 5000;
			let maxIterations = 500;
			let iterations = 0;
			let effectRow = findAnovaEffectRowAtSampleSize(effectLabel, sampleSizeCandidate, cohensF);

			while(effectRow && (effectRow.power / 100) < targetPower && sampleSizeCandidate < maxParticipants && iterations < maxIterations) {
				sampleSizeCandidate += stepSize;
				effectRow = findAnovaEffectRowAtSampleSize(effectLabel, sampleSizeCandidate, cohensF);
				iterations++;
			}

			return {
				minimumN: sampleSizeCandidate,
				requiredN: roundUpToNextDivisible(sampleSizeCandidate, getDesignAlignmentMultiple()),
				effectRow: effectRow
			};
		}

		function getSelectedAnovaControlLabel(effectRows) {
			if(!lastAnovaPowerResult) {
				return null;
			}

			let selectedLabel = lastAnovaPowerResult.selectedControllingLabel;
			let exists = effectRows.some(function(row) {
				return row.label === selectedLabel;
			});

			if(exists) {
				return selectedLabel;
			}

			return null;
		}

		function getNominalRCode() {
			if(isTTestScenario()) {
				if(studyDesign.withinIVs.length > 0) {
					return "library(rstatix)<br />t_test(data = data, " + studyDesign.DVs[0].name + " ~ " + studyDesign.IVs[0].name + ", paired = TRUE)<br />cohens_d(data = data, " + studyDesign.DVs[0].name + " ~ " + studyDesign.IVs[0].name + ", paired = TRUE)";
				}

				return "library(rstatix)<br />t_test(data = data, " + studyDesign.DVs[0].name + " ~ " + studyDesign.IVs[0].name + ", paired = FALSE)<br />cohens_d(data = data, " + studyDesign.DVs[0].name + " ~ " + studyDesign.IVs[0].name + ", paired = FALSE)";
			}

			if(studyDesign.withinIVs.length >= 1 && studyDesign.betweenIVs.length >= 1) {
				return "library(rstatix)<br />aov <- anova_test(data = data, dv = " + studyDesign.DVs[0].name + ", wid = SubjectID, between = c(" + getNamesFromArray(studyDesign.betweenIVs, ", ", "name").slice(0, -2) + "), within = c(" + getNamesFromArray(studyDesign.withinIVs, ", ", "name").slice(0, -2) + "), effect.size = \"pes\")<br />get_anova_table(aov, correction = \"auto\")";
			}

			if(studyDesign.withinIVs.length >= 1) {
				return "library(rstatix)<br />aov <- anova_test(data = data, dv = " + studyDesign.DVs[0].name + ", wid = SubjectID, within = c(" + getNamesFromArray(studyDesign.withinIVs, ", ", "name").slice(0, -2) + "), effect.size = \"pes\")<br />get_anova_table(aov, correction = \"auto\")";
			}

			return "library(rstatix)<br />aov <- anova_test(data = data, dv = " + studyDesign.DVs[0].name + ", between = c(" + getNamesFromArray(studyDesign.betweenIVs, ", ", "name").slice(0, -2) + "), effect.size = \"pes\")<br />get_anova_table(aov)";
		}

		function getRegressionRCode() {
			return "lm_model <- lm(" + studyDesign.DVs[0].name + " ~ " + getNamesFromArray(studyDesign.nonOrdinalIVs, " + ", "name").slice(0, -3) + ", data = data)<br />summary(lm_model)";
		}

		function appendPowerTabs(containerId, uniqueId, overviewHtml, formulaHtml, placeholderHtml) {
			let tabsHtml = '<ul class="nav nav-pills mb-3 mt-3" id="power-tabs-' + uniqueId + '" role="tablist">' +
				'<li class="nav-item" role="presentation"><button class="nav-link active" id="overview-tab-' + uniqueId + '" data-bs-toggle="pill" data-bs-target="#overview-' + uniqueId + '" type="button" role="tab">Overview</button></li>' +
				'<li class="nav-item" role="presentation"><button class="nav-link" id="formula-tab-' + uniqueId + '" data-bs-toggle="pill" data-bs-target="#formula-' + uniqueId + '" type="button" role="tab">Formula</button></li>' +
				'<li class="nav-item" role="presentation"><button class="nav-link" id="placeholder-tab-' + uniqueId + '" data-bs-toggle="pill" data-bs-target="#placeholder-' + uniqueId + '" type="button" role="tab">Placeholder data</button></li>' +
				'</ul>' +
				'<div class="tab-content">' +
				'<div class="tab-pane fade show active" id="overview-' + uniqueId + '" role="tabpanel">' + overviewHtml + '</div>' +
				'<div class="tab-pane fade" id="formula-' + uniqueId + '" role="tabpanel">' + formulaHtml + '</div>' +
				'<div class="tab-pane fade" id="placeholder-' + uniqueId + '" role="tabpanel">' + placeholderHtml + '</div>' +
				'</div>';

			$(containerId).append(tabsHtml);
		}

		function replacePowerAccordion(collapseId, resultStr) {
			let existingCollapse = $("#power").find("#" + collapseId);
			let existingAccordion = existingCollapse.closest(".accordion");
			let wasOpen = existingCollapse.hasClass("show");

			if(existingAccordion.length > 0) {
				existingAccordion.replaceWith(resultStr);

				if(wasOpen) {
					let newCollapse = $("#power").find("#" + collapseId);
					let newButton = newCollapse.closest(".accordion-item").find(".accordion-button").first();
					newCollapse.addClass("show");
					newButton.removeClass("collapsed").attr("aria-expanded", "true");
				}

				return;
			}

			$("#power").append(resultStr);
		}

		function showRegressionPowerAndEffectSizes(regressionResult, participants){
			$("#rowES").show();
			let requiredN = getRequiredSampleSizeForCurrentDesign(regressionResult.minimumN || participants);
			let selectedRegressionResult = StudyPowerEngine.estimateRegressionPower({
				predictors: studyDesign.nonOrdinalIVs.length,
				participants: requiredN,
				effectSizeFSquared: resolveEffectSizes().cohensF * resolveEffectSizes().cohensF,
				alpha: 0.05,
			});
			let summaryHtml = buildPowerSummary(regressionResult.minimumN || requiredN, requiredN, "Overall regression model", getTargetPower());
			let tableBody = "";
			let selectedRegressionPoint = {
				label: "Overall regression model",
				power: selectedRegressionResult.power
			};
			let curvePoints = buildConsistentCurvePoints(
				(regressionResult.curvePoints || []).map(function(point) {
					return {
						totalParticipants: point.totalParticipants,
						rows: [{
							label: "Overall regression model",
							power: point.rows[0].power
						}]
					};
				}),
				requiredN,
				[selectedRegressionPoint]
			);

			$(selectedRegressionResult.tableRows).each(function(i){
				tableBody += "<tr><td>" + selectedRegressionResult.tableRows[i].label + "</td><td>" + selectedRegressionResult.tableRows[i].value + "</td></tr>";
			});

			let overviewHtml = summaryHtml +
				'<div class="chart-shell" style="height: 320px;"><canvas id="powerChartRegression"></canvas></div>' +
				'<div class="table-responsive mt-3"><table class="table table-striped table-bordered"><thead><tr><th>Regression parameter</th><th>Value</th></tr></thead><tbody>' + tableBody + '</tbody></table></div>';
			let formulaHtml = buildRegressionFormula(selectedRegressionResult, requiredN);
			let resultStr = '<div class="accordion"><div class="accordion-item"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseREGRESSIONES" aria-controls="collapseREGRESSIONES"><h6 class="accordion-header">' + getDataTypeIcon("H") + ' A-priori sample size analysis</h6></button><div id="collapseREGRESSIONES" class="accordion-collapse collapse"><div class="accordion-body bg-light" id="regressionPowerBody"></div></div></div></div>';

			replacePowerAccordion("collapseREGRESSIONES", resultStr);
			appendPowerTabs("#regressionPowerBody", "regression", overviewHtml, formulaHtml, buildPlaceholderDataTab());
			renderPowerChart("powerChartRegression", curvePoints, regressionResult.minimumN || requiredN, regressionResult.power, requiredN, getTargetPower());
			$("#resultsPanel").show();
		}

		function showTTestPowerAndEffectSizes(tTestResult, participants) {
			$("#rowES").show();
			let requiredN = getRequiredSampleSizeForCurrentDesign(tTestResult.minimumN || participants);
			let selectedResult = computeTTestPowerAtSampleSize(requiredN, resolveEffectSizes().cohensD, studyDesign.withinIVs.length > 0, getCurrentWithinCorrelation());
			selectedResult.label = selectedResult.label || (studyDesign.withinIVs.length > 0 ? "Paired t-test" : "Independent t-test");
			let summaryHtml = buildPowerSummary(tTestResult.minimumN, requiredN, studyDesign.withinIVs.length > 0 ? "Paired t-test" : "Independent t-test", getTargetPower());
			let curvePoints = buildConsistentCurvePoints(
				tTestResult.curvePoints.slice(),
				requiredN,
				[computeTTestPowerAtSampleSize(requiredN, resolveEffectSizes().cohensD, studyDesign.withinIVs.length > 0, getCurrentWithinCorrelation())]
			);

			let tableHtml = '<div class="chart-shell" style="height: 320px;"><canvas id="powerChartTTest"></canvas></div>' +
				'<div class="table-responsive mt-3"><table class="table table-striped table-bordered"><thead><tr><th>Statistic</th><th>Value</th></tr></thead><tbody>' +
				'<tr><td>Power</td><td>' + roundTo(selectedResult.power * 100, 1) + '%</td></tr>' +
				'<tr><td>Cohen\'s d</td><td>' + roundTo(selectedResult.cohenD, 3) + '</td></tr>' +
				(studyDesign.withinIVs.length > 0 ? '<tr><td>Cohen\'s d<sub>z</sub></td><td>' + roundTo(selectedResult.cohenDz, 3) + '</td></tr>' : "") +
				'<tr><td>Cohen\'s f</td><td>' + roundTo(selectedResult.cohenF, 3) + '</td></tr>' +
				'<tr><td>Partial eta squared</td><td>' + roundTo(selectedResult.partialEtaSquared, 3) + '</td></tr>' +
				'<tr><td>Degrees of freedom</td><td>' + selectedResult.df2 + '</td></tr>' +
				'<tr><td>Critical t</td><td>' + roundTo(selectedResult.criticalT, 6) + '</td></tr>' +
				'<tr><td>Noncentrality δ</td><td>' + roundTo(selectedResult.delta, 6) + '</td></tr>' +
				(studyDesign.withinIVs.length === 0 ? '<tr><td>Sample size per group</td><td>' + selectedResult.groupSampleSize + '</td></tr>' : "") +
				'</tbody></table></div>';
			let formulaHtml = buildTTestFormula(selectedResult);
			let resultStr = '<div class="accordion"><div class="accordion-item"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseTTESTES" aria-controls="collapseTTESTES"><h6 class="accordion-header">' + getDataTypeIcon("H") + ' A-priori sample size analysis</h6></button><div id="collapseTTESTES" class="accordion-collapse collapse"><div class="accordion-body bg-light" id="ttestPowerBody"></div></div></div></div>';

			replacePowerAccordion("collapseTTESTES", resultStr);
			appendPowerTabs("#ttestPowerBody", "ttest", summaryHtml + tableHtml, formulaHtml, buildPlaceholderDataTab());
			renderPowerChart("powerChartTTest", curvePoints, tTestResult.minimumN, tTestResult.effectRow ? tTestResult.effectRow.power : null, requiredN, getTargetPower());
			$("#resultsPanel").show();
		}

		function showANOVAPowerAndEffectSizes(anovaResult, participants){
			$("#rowES").show();
			let effectSizes = resolveEffectSizes();
			let storedTargets = lastAnovaPowerResult && lastAnovaPowerResult.effectTargetPowers ? lastAnovaPowerResult.effectTargetPowers : {};
			let effectRequirementRows = anovaResult.effectRows.map(function(row) {
				let targetPower = normalizeTargetPowerValue(storedTargets[row.label]);
				let requirements = estimateMinimumForAnovaEffect(row.label, targetPower, effectSizes.cohensF);

				return Object.assign({}, row, {
					targetPower: targetPower,
					minimumN: requirements.minimumN,
					requiredN: requirements.requiredN,
					minimumPower: requirements.effectRow ? requirements.effectRow.power / 100 : null
				});
			});
			// The controlling effect is user-selectable. The currently selected row
			// drives the summary above, the formula tab, and the Required N shown in the chart.
			let selectedControllingLabel = getSelectedAnovaControlLabel(effectRequirementRows);
			let controllingRow = effectRequirementRows.find(function(row) {
				return row.label === selectedControllingLabel;
			}) || effectRequirementRows.reduce(function(best, row) {
				if(!best || row.requiredN > best.requiredN) {
					return row;
				}

				return best;
			}, null);
			let requiredN = controllingRow ? controllingRow.requiredN : participants;
			let minimumN = controllingRow ? controllingRow.minimumN : anovaResult.minimumN;
			let selectedPower = StudyPowerEngine.estimateAnovaPower({
				factors: getNominalFactors(),
				effectSizeF: effectSizes.cohensF,
				alpha: 0.05,
				totalParticipants: requiredN,
				withinCorrelation: getCurrentWithinCorrelation()
			});
			let selectedRows = selectedPower.rows.map(function(row) {
				return {
					label: row._row,
					power: row.power / 100,
					cohenF: row.cohen_f,
					partialEtaSquared: row.partial_eta_squared,
					df1: row.df1,
					df2: row.df2
				};
			});
			effectRequirementRows = effectRequirementRows.map(function(requirementRow) {
				let selectedRow = selectedRows.find(function(row) {
					return row.label === requirementRow.label;
				});

				return Object.assign({}, requirementRow, selectedRow || {});
			});
			controllingRow = effectRequirementRows.find(function(row) {
				return row.label === (controllingRow ? controllingRow.label : "");
			}) || controllingRow;
			let curvePoints = buildConsistentCurvePoints(anovaResult.curvePoints.slice(), requiredN, selectedRows);
			let overviewHtml = buildPowerSummary(minimumN, requiredN, controllingRow ? controllingRow.label : "N/A", controllingRow ? controllingRow.targetPower : getTargetPower()) +
				'<div class="chart-shell" style="height: 340px;"><canvas id="powerChartAnova"></canvas></div>' +
				'<div class="table-responsive mt-3"><table id="powerOutputTable" class="table table-striped table-bordered table-sm power-output-table"><thead><tr><th>Use</th><th>Effect</th><th>Type</th><th>Observed power</th><th>Target power</th><th>Min. N</th><th>Req. N</th><th>Cohen\'s f</th><th>partial eta²</th><th>df1</th><th>df2</th></tr></thead><tbody>' +
				effectRequirementRows.map(function(row) {
					let isChecked = controllingRow && row.label === controllingRow.label ? " checked" : "";
					return "<tr><td><input class=\"form-check-input anova-controlling-effect\" type=\"radio\" name=\"anovaControllingEffect\" data-effect-label=\"" + row.label + "\"" + isChecked + "></td><td>" + row.label + "</td><td>" + formatAnovaEffectType(row.effectType) + "</td><td>" + roundTo(row.power * 100, 1) + "%</td><td><input class=\"form-control form-control-sm anova-target-power-input\" type=\"number\" min=\"50\" max=\"99\" step=\"1\" value=\"" + roundTo(row.targetPower * 100, 0) + "\" data-effect-label=\"" + row.label + "\"></td><td>" + row.minimumN + "</td><td>" + row.requiredN + "</td><td>" + roundTo(row.cohenF, 3) + "</td><td>" + roundTo(row.partialEtaSquared, 3) + "</td><td>" + row.df1 + "</td><td>" + row.df2 + "</td></tr>";
				}).join("") +
				'</tbody></table></div>' +
				'<p class="helper-copy mt-3">Choose which effect should control the reported sample size and set a separate target power for each effect if needed.</p>';
			let detailedControllingRow = controllingRow ? anovaResult.effectRows.find(function(row) {
				return row.label === controllingRow.label;
			}) : null;
			let formulaHtml = detailedControllingRow ? buildAnovaPowerFormula(detailedControllingRow, requiredN) : "<p>No ANOVA effect available.</p>";
			let resultStr = '<div class="accordion"><div class="accordion-item"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseANOVAES" aria-controls="collapseANOVAES"><h6 class="accordion-header">' + getDataTypeIcon("H") + ' A-priori sample size analysis</h6></button><div id="collapseANOVAES" class="accordion-collapse collapse"><div class="accordion-body bg-light" id="anovaPowerBody"></div></div></div></div>';

			replacePowerAccordion("collapseANOVAES", resultStr);
			appendPowerTabs("#anovaPowerBody", "anova", overviewHtml, formulaHtml, buildPlaceholderDataTab());
			renderPowerChart("powerChartAnova", curvePoints, minimumN, controllingRow ? controllingRow.minimumPower : null, requiredN, controllingRow ? controllingRow.targetPower : getTargetPower());
			lastAnovaPowerResult.effectTargetPowers = effectRequirementRows.reduce(function(targets, row) {
				targets[row.label] = row.targetPower;
				return targets;
			}, {});
			lastAnovaPowerResult.selectedControllingLabel = controllingRow ? controllingRow.label : null;
			$("#anovaPowerBody .anova-controlling-effect").off("change").on("change", function() {
				lastAnovaPowerResult.selectedControllingLabel = $(this).data("effect-label");
				showANOVAPowerAndEffectSizes(lastAnovaPowerResult, participants);
			});
			$("#anovaPowerBody .anova-target-power-input").off("input change").on("input change", function() {
				let effectLabel = $(this).data("effect-label");
				let normalizedTarget = normalizeTargetPowerValue(parseFloat($(this).val()) / 100);
				lastAnovaPowerResult.effectTargetPowers = lastAnovaPowerResult.effectTargetPowers || {};
				lastAnovaPowerResult.selectedControllingLabel = effectLabel;
				lastAnovaPowerResult.effectTargetPowers[effectLabel] = normalizedTarget;
				$(this).val(roundTo(normalizedTarget * 100, 0));
				showANOVAPowerAndEffectSizes(lastAnovaPowerResult, participants);
			});
			$("#resultsPanel").show();
		}

		function buildAnovaPowerFormula(effectRow, selectedParticipants) {
			let safeLambda = Number.isFinite(effectRow.lambda) ? effectRow.lambda : 0;
			let safeF = Number.isFinite(effectRow.cohenF) ? effectRow.cohenF : 0;
			let safeFSquared = safeF * safeF;
			let lambdaWeight = safeFSquared > 0 && selectedParticipants > 0 ? safeLambda / (selectedParticipants * safeFSquared) : 0;

			return '<div class="formula-stack">' +
				'<p>This result is based on the controlling ANOVA effect <strong>' + effectRow.label + '</strong> (' + (effectRow.effectType || "ANOVA effect") + ').</p>' +
				'<math display="block"><mrow><mi>Power</mi><mo>=</mo><mn>1</mn><mo>-</mo><msub><mi>F</mi><mi>ncf</mi></msub><mo>(</mo><msub><mi>F</mi><mi>crit</mi></msub><mo>;</mo><mi>df</mi><mn>1</mn><mo>=</mo><mn>' + effectRow.df1 + '</mn><mo>,</mo><mi>df</mi><mn>2</mn><mo>=</mo><mn>' + effectRow.df2 + '</mn><mo>,</mo><mi>&lambda;</mi><mo>=</mo><mn>' + roundTo(safeLambda, 3) + '</mn><mo>)</mo></mrow></math>' +
				'<math display="block"><mrow><mi>&lambda;</mi><mo>=</mo><mi>N</mi><mo>&times;</mo><msup><mi>f</mi><mn>2</mn></msup><mo>&times;</mo><mi>w</mi><mo>=</mo><mn>' + selectedParticipants + '</mn><mo>&times;</mo><mn>' + roundTo(safeFSquared, 3) + '</mn><mo>&times;</mo><mn>' + roundTo(lambdaWeight, 3) + '</mn></mrow></math>' +
				'<p><strong>Step 1.</strong> The current participant count is <strong>N = ' + selectedParticipants + '</strong>.</p>' +
				'<p><strong>Step 2.</strong> The selected omnibus effect size is <strong>f = ' + roundTo(safeF, 3) + '</strong>, therefore <strong>f² = ' + roundTo(safeFSquared, 3) + '</strong>.</p>' +
				'<p><strong>Step 3.</strong> The model-specific weight is <strong>w = ' + roundTo(lambdaWeight, 3) + '</strong>, which leads to <strong>&lambda; = ' + roundTo(safeLambda, 3) + '</strong>.</p>' +
				'<p><strong>Step 4.</strong> With <strong>df1 = ' + effectRow.df1 + '</strong> and <strong>df2 = ' + effectRow.df2 + '</strong>, the noncentral F distribution yields the reported power for this specific ANOVA effect.</p>' +
				'</div>';
		}

		function buildRegressionFormula(regressionResult, selectedParticipants) {
			let fSquaredRow = regressionResult.tableRows.find(function(row) { return row.label === "Effect size (f²)"; });
			let fSquared = fSquaredRow ? parseFloat(fSquaredRow.value) : 0;
			let predictorsRow = regressionResult.tableRows.find(function(row) { return row.label === "Predictors"; });
			let numeratorDfRow = regressionResult.tableRows.find(function(row) { return row.label === "Numerator df (u)"; });
			let denominatorDfRow = regressionResult.tableRows.find(function(row) { return row.label === "Denominator df (v)"; });

			return '<div class="formula-stack">' +
				'<p>This result is based on the overall multiple regression model.</p>' +
				'<math display="block"><mrow><mi>Power</mi><mo>=</mo><mn>1</mn><mo>-</mo><msub><mi>F</mi><mi>ncf</mi></msub><mo>(</mo><msub><mi>F</mi><mi>crit</mi></msub><mo>;</mo><mi>u</mi><mo>=</mo><mn>' + (numeratorDfRow ? numeratorDfRow.value : "?") + '</mn><mo>,</mo><mi>v</mi><mo>=</mo><mn>' + (denominatorDfRow ? denominatorDfRow.value : "?") + '</mn><mo>,</mo><mi>&lambda;</mi><mo>=</mo><mn>' + roundTo(selectedParticipants * fSquared, 3) + '</mn><mo>)</mo></mrow></math>' +
				'<math display="block"><mrow><mi>&lambda;</mi><mo>=</mo><mi>N</mi><mo>&times;</mo><msup><mi>f</mi><mn>2</mn></msup><mo>=</mo><mn>' + selectedParticipants + '</mn><mo>&times;</mo><mn>' + roundTo(fSquared, 3) + '</mn><mo>=</mo><mn>' + roundTo(selectedParticipants * fSquared, 3) + '</mn></mrow></math>' +
				'<p><strong>Step 1.</strong> The model contains <strong>' + (predictorsRow ? predictorsRow.value : "?") + '</strong> predictor(s).</p>' +
				'<p><strong>Step 2.</strong> The expected regression effect is <strong>f² = ' + roundTo(fSquared, 3) + '</strong>.</p>' +
				'<p><strong>Step 3.</strong> With <strong>N = ' + selectedParticipants + '</strong>, this gives <strong>&lambda; = ' + roundTo(selectedParticipants * fSquared, 3) + '</strong>.</p>' +
				'<p><strong>Step 4.</strong> The F test then uses <strong>u = ' + (numeratorDfRow ? numeratorDfRow.value : "?") + '</strong> and <strong>v = ' + (denominatorDfRow ? denominatorDfRow.value : "?") + '</strong> to compute the final power.</p>' +
				'</div>';
		}
})();


