(() => {
'use strict';
let debug = false; // Flag for enabling debug mode
		let IVs = 0; // Counter for Independent Variables (IVs)
		let DVs = 0; // Counter for Dependent Variables (DVs) 
		let manualSampleSizeUpdate = false; // Flag for manual subject update
		let serverANOVARequestRunning = false; // Flag for ANOVA request status
		let serverRegressionRequestRunning = false; // Flag for regression request status
		let serverRequestRunning = false; // Flag for SAMPLE request status
		let studyDesign; // Object to hold study design details
		let sampleSize = 0; // Variable to store sample size
		let sampleSizeReady = false; // Flag for completed sample size estimation
		let lastAnovaPowerResult = null;
		let lastRegressionPowerResult = null;
		let lastTTestPowerResult = null;
		let powerChartInstance = null;
		let plannerUpdateSuspended = false;
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
			return hasNominalFactors() && studyDesign.nonOrdinalIVs.length === 0 && studyDesign.DVs.length === 1 && studyDesign.IVs.length === 1 && studyDesign.IVs[0].type === "N" && studyDesign.IVs[0].levels.length === 2;
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
		 
		$(document).ready(function() { 
			resetStudyDesign();
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
			$("input[name='nameIV']").attr('placeholder', "Enter IV name..."); 
			
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
			$("select[name='selectIVwithin']").append(new Option('within-subject (subjects are all assigned to this IV)', "within"));
			$("select[name='selectIVwithin']").append(new Option('between-subject (subjects are separated into groups)', "between"));
			
			$("input[name='manovaCheckBox']").prop( 'checked', false ); 			
			
			$("#btnExample2x3Within").click(function() { example2x3Within(); }); 		
			$("#btnExample2x4Mixed").click(function()  { example2x4Mixed(); }); 		
			$("#btnExampleRegression").click(function() { exampleRegression(); }); 		
			
			$("select[name='selectIVType']").change(function() { 
				if($("select[name='selectIVType']").val() == "N"){
					$("#levelsIV").show();
					$("#withinIV").show();
				} else {
					$("#levelsIV").hide();
					$("#withinIV").hide();
				}
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

				if (effectMode === "d") {
					$("#effectSizeInputId").val($("#effectSizeInputId").val() || "0.500");
					$("#effectSizeModeHint").text("Cohen's d is exact for the paired and independent two-condition tests. For multifactor ANOVAs it is shown as a two-condition reference contrast.");
				} else if (effectMode === "eta") {
					$("#effectSizeModeHint").text("Partial eta squared defines the omnibus ANOVA effect directly.");
				} else if (effectMode === "f") {
					$("#effectSizeModeHint").text("Cohen's f defines the omnibus ANOVA effect directly and is closest to the G-Power reference exports.");
				} else {
					$("#effectSizeModeHint").text("The planner derives a reference contrast effect from the current min/max mean difference and pooled SD.");
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
				
				if($("input[name='nameIV']").val() == "") return;
				if($("select[name='selectIVType']").val() == "") return;
				
				if($("select[name='selectIVType']").val() == "N") {
					if($('input[name="enterLevelsIV"]').val() == "") return; 
				} else { 
					$("select[name='selectIVwithin'] option:eq(1)").prop("selected", true);
				}
				
				let iconIVstr = "";
				let levelsIVstr = ""; 
				let levels = [ ];
				let IV = {
					"id": 0,
					"name": "",
					"type": "",
					"levels": [],
					"within": "" };
					
				iconIVstr += getDataTypeIcon($("select[name='selectIVType']").val()); 
								
				if($("select[name='selectIVType']").val() == "N") {
					$("#withinIV").show();
					$("#levelsIV").show();  
					levels = $('input[name="enterLevelsIV"]').val().split(',');
					
					if(levels){
						levelsIVstr = '<ul class="list-group list-group-horizontal">';
						$.each(levels, function(i){
							levelsIVstr += '<small><li class="list-group-item">' + levels[i] + '</li></small>'; 
							levels[i] = $.trim(levels[i]).replaceAll(" ","");
						});
						levelsIVstr += '</ul>';
						IV.levels = levels; 
					} 					
				} else {
					$("#levelsIV").hide();
					$("#withinIV").hide();
				}
				
				$("#listIV").append('<button type="button" id="buttonIV_' + IVs + '" class="btn btn-light me-1 mt-1"  style="vertical-align: top;">' + iconIVstr + $("input[name='nameIV']").val() + ' (' + $("select[name='selectIVwithin']").val() + ') <i class="bi ms-1 bi-x"" c></i>' + levelsIVstr + '</button>');
				
				$("#buttonIV_" + IVs).click(function(){  						
					let removeItem;
					let myNumber = this.id.split('_')[1];
					$.each(studyDesign.IVs, function(i){
						if(studyDesign.IVs[i].id == myNumber) removeItem = i; 
					});
					studyDesign.IVs.splice(removeItem, 1); 
					$(this).remove();   
					clearOutputAndWait();
					displayDependentVariableInput();  
					$("#addIV").removeClass('disabled'); 
				});
								
				IV.id = IVs;
				IV.name = $("input[name='nameIV']").val();
				IV.type = $("select[name='selectIVType']").val();
				IV.within = $("select[name='selectIVwithin']").val();
				
				studyDesign.IVs.push(IV); 
				
				$("input[name='nameIV']").val("");
				$("select[name='selectIVType'] option:eq(0)").prop("selected", true);
				$("select[name='selectIVwithin'] option:eq(0)").prop("selected", true);
				$('input[name="enterLevelsIV"]').val("")
					
				$("#levelsIV").hide();
				$("#withinIV").hide();	

				clearOutputAndWait();
				displayDependentVariableInput();	
 
				if(studyDesign.IVs.length > 2)  $("#addIV").addClass('disabled'); 
				else $("#addIV").removeClass('disabled');					
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
					$("#cellEffectMode").show();
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
				
				if($("input[name='nameDV']").val() == "") return;
				if($("select[name='selectDVType']").val() == "") return;
			
				let iconDVstr = "";
				let DV = {
					"id": 0,
					"name": "",
					"type": "" };
				DVs++;
				iconDVstr += getDataTypeIcon($("select[name='selectDVType']").val()); 
				
				$("#listDV").append('<button type="button" id="buttonDV_' + DVs + '" class="btn btn-light me-1 mt-1 ">' + iconDVstr + $("input[name='nameDV']").val() + '<i class="bi ms-1 bi-x "></i></button>');
				
				$("#buttonDV_" + DVs).click(function(){ 
					let removeItem;
					let myNumber = this.id.split('_')[1];
					
					$.each(studyDesign.DVs, function(i){
						if(studyDesign.DVs[i].id == myNumber) removeItem = i; 
					}); 
					
					studyDesign.DVs.splice(removeItem, 1); 
					$(this).remove();  
					clearOutputAndWait();
					displayDependentVariableInput();  
					$("#addDV").removeClass('disabled');  
				});
				
				DV.id = DVs;
				DV.name = $("input[name='nameDV']").val();
				DV.type = $("select[name='selectDVType']").val(); 
				studyDesign.DVs.push(DV); 
				
				$("input[name='nameDV']").val("");
				$("select[name='selectDVType'] option:eq(0)").prop("selected", true); 
				resetSampleSizeProgress();
				refreshPlanner();
				
				if(studyDesign.DVs.length > 3) {
					$("#addDV").addClass('disabled'); 
				} else {
					$("#addDV").removeClass('disabled');
				}	 
				$("#rowWAIT").text("Please wait..."); 
			$("#rowWAITContainer").show();
				$("#cellVariance").show();
				$("#cellDeltaMeans").show();
				$("#cellEffectSize").show();
			}); 
			 
			function refreshPlanner(){ 
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
			}
				
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
				$('[id*=buttonDV_]').each(function() { $(this).click(); });
				$('[id*=buttonIV_]').each(function() { $(this).click(); });
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
			let text = "Cohen's <i>d</i> = " + cohensD + " <i>(" + interpretCohensd(parseFloat(cohensD)) + ")</i>, Cohen's <i>f</i> = " + cohensF + " <i>(" + interpretCohensf(parseFloat(cohensF)) + ")</i>, <i>&eta;<sub>p</sub><sup>2</sup></i> = " + partialEtaSq + " <i>(" + interpretPartialEtaSquared(parseFloat(partialEtaSq)) + ")</i>";

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
			resetSampleSizeProgress();
			destroyPowerChart();

			if(studyDesign.IVs.length > 0 && studyDesign.DVs.length > 0) {
				$("#rowWAIT").text("Please wait..."); 
			$("#rowWAITContainer").show();
				$("#rowES").hide();
				$("#rowST").hide(); 
				$("#rowED").hide(); 
				$("#cellMANOVA").hide();
				if($("#sampleSizeSlider").is(":hidden")) $("#sampleSizePleaseWait").show();
				else  $("#sampleSizePleaseWait").hide();
				$("#cellSampleSize").show(); 
			} else {
				$("#rowWAIT").text("No study design possible..."); 
			$("#rowWAITContainer").show();
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
					resultStr += "To avoid sequence effects order the " + studyDesign.withinConditions.length + " conditions of your within-subject IVs into <i>permutations</i>. Repeat the permutations with a multiple of " + permutations(studyDesign.withinConditions).length + ". For example with " + (permutations(studyDesign.withinConditions).length * 2) + ", " +  (permutations(studyDesign.withinConditions).length * 3) + ", " +  (permutations(studyDesign.withinConditions).length * 4) + "... subjects." + arrayToDesignSequence(studyDesign.withinConditions, "permutations") + ""; 
				}
				if(studyDesign.withinConditions.length > 3 && studyDesign.withinConditions.length <= 12) { 
					resultStr += "To avoid sequence effects order the " + studyDesign.withinConditions.length + " conditions of your within-subject IVs using a <i>" + studyDesign.withinConditions.length + " &times; " + studyDesign.withinConditions.length + " balanced Latin Square</i>. Repeat the Latin Square with a multiple of " + (studyDesign.withinConditions.length) + ". For example with " + (studyDesign.withinConditions.length * 2) + ", " +  (studyDesign.withinConditions.length * 3) + ", " +  (studyDesign.withinConditions.length * 4) + "... subjects." + arrayToDesignSequence(studyDesign.withinConditions, "latinSquare") + "";
				}
				if(studyDesign.withinConditions.length > 12) { 
					resultStr += "To avoid sequence effects put the " + studyDesign.withinConditions.length + " following conditions into a <i>pseudo-randomized order</i>. For example: " + arrayToDesignSequence(studyDesign.withinConditions, "shuffle", studyDesign.samples) ; 
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
			let normalizedPoints = dedupeAndSortCurvePoints(curvePoints);

			if(Array.isArray(requiredRows) && requiredRows.length > 0 && isFinite(requiredN)) {
				let hasRequiredPoint = normalizedPoints.some(function(point) {
					return point.totalParticipants === requiredN;
				});

				if(!hasRequiredPoint) {
					normalizedPoints.push({
						totalParticipants: requiredN,
						rows: requiredRows
					});
					normalizedPoints = dedupeAndSortCurvePoints(normalizedPoints);
				}
			}

			return normalizedPoints;
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

		function renderPowerChart(canvasId, curvePoints, highlightedN, requiredN, targetPower) {
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
				data: labels.map(function(value) {
					return { x: value, y: roundTo(targetPower * 100, 1) };
				}),
				borderColor: "#111827",
				borderDash: [6, 4],
				pointRadius: 0,
				tension: 0,
				fill: false
			});

			datasets.push({
				label: "Minimum N",
				data: labels.map(function(value) {
					return value === highlightedN ? { x: value, y: roundTo(targetPower * 100, 1) } : null;
				}),
				borderColor: "#111827",
				backgroundColor: "#111827",
				showLine: false,
				pointRadius: 6,
				pointHoverRadius: 7
			});

			datasets.push({
				label: "Required N",
				data: labels.map(function(value) {
					return value === requiredN ? { x: value, y: roundTo(targetPower * 100, 1) } : null;
				}),
				borderColor: "#c2410c",
				backgroundColor: "#c2410c",
				showLine: false,
				pointStyle: "rectRot",
				pointRadius: 6,
				pointHoverRadius: 7
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
			let lambdaWeight = effectRow.cohenF > 0 ? effectRow.lambda / (selectedParticipants * effectRow.cohenF * effectRow.cohenF) : 0;
			return "<code>Power = 1 - F<sub>ncf</sub>(F<sub>crit</sub>; df1 = " + effectRow.df1 + ", df2 = " + effectRow.df2 + ", &lambda; = " + roundTo(effectRow.lambda, 3) + ")</code><br /><code>&lambda; = N &times; f<sup>2</sup> &times; w = " + selectedParticipants + " &times; " + roundTo(effectRow.cohenF * effectRow.cohenF, 3) + " &times; " + roundTo(lambdaWeight, 3) + "</code>";
		}

		function buildRegressionFormula(regressionResult, selectedParticipants) {
			let fSquaredRow = regressionResult.tableRows.find(function(row) { return row.label === "Effect size (f^2)"; });
			let fSquared = fSquaredRow ? parseFloat(fSquaredRow.value) : 0;
			return "<code>Power = 1 - F<sub>ncf</sub>(F<sub>crit</sub>; u = p, v = N - p - 1, &lambda; = N &times; f<sup>2</sup>)</code><br /><code>&lambda; = " + selectedParticipants + " &times; " + roundTo(fSquared, 3) + " = " + roundTo(selectedParticipants * fSquared, 3) + "</code>";
		}

		function buildPowerSummary(minimumN, requiredN, controllingLabel) {
			return "<p><strong>Minimum N:</strong> " + minimumN + " participants to reach the selected target power.</p><p><strong>Required N:</strong> " + requiredN + " participants after rounding to the current design sequence multiple.</p><p><strong>Controlling effect:</strong> " + controllingLabel + "</p>";
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

		function appendPowerTabs(containerId, uniqueId, overviewHtml, formulaHtml, rCodeHtml) {
			let tabsHtml = '<ul class="nav nav-pills mb-3 mt-3" id="power-tabs-' + uniqueId + '" role="tablist">' +
				'<li class="nav-item" role="presentation"><button class="nav-link active" id="overview-tab-' + uniqueId + '" data-bs-toggle="pill" data-bs-target="#overview-' + uniqueId + '" type="button" role="tab">Overview</button></li>' +
				'<li class="nav-item" role="presentation"><button class="nav-link" id="formula-tab-' + uniqueId + '" data-bs-toggle="pill" data-bs-target="#formula-' + uniqueId + '" type="button" role="tab">Formula</button></li>' +
				'<li class="nav-item" role="presentation"><button class="nav-link" id="rcode-tab-' + uniqueId + '" data-bs-toggle="pill" data-bs-target="#rcode-' + uniqueId + '" type="button" role="tab">R code</button></li>' +
				'</ul>' +
				'<div class="tab-content">' +
				'<div class="tab-pane fade show active" id="overview-' + uniqueId + '" role="tabpanel">' + overviewHtml + '</div>' +
				'<div class="tab-pane fade" id="formula-' + uniqueId + '" role="tabpanel">' + formulaHtml + '</div>' +
				'<div class="tab-pane fade" id="rcode-' + uniqueId + '" role="tabpanel"><code>' + rCodeHtml + '</code></div>' +
				'</div>';

			$(containerId).append(tabsHtml);
		}

		function showRegressionPowerAndEffectSizes(regressionResult, participants){
			$("#rowES").show();
			let summaryHtml = buildPowerSummary(regressionResult.minimumN || participants, participants, "Overall regression model");
			let tableBody = "";
			let selectedRegressionPoint = {
				label: "Overall regression model",
				power: regressionResult.power
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
				participants,
				[selectedRegressionPoint]
			);

			$(regressionResult.tableRows).each(function(i){
				tableBody += "<tr><td>" + regressionResult.tableRows[i].label + "</td><td>" + regressionResult.tableRows[i].value + "</td></tr>";
			});

			let overviewHtml = summaryHtml +
				'<div class="chart-shell" style="height: 320px;"><canvas id="powerChartRegression"></canvas></div>' +
				'<div class="table-responsive mt-3"><table class="table table-striped table-bordered"><thead><tr><th>Regression parameter</th><th>Value</th></tr></thead><tbody>' + tableBody + '</tbody></table></div>';
			let formulaHtml = "<p>" + buildRegressionFormula(regressionResult, participants) + "</p>";
			let resultStr = '<div class="accordion"><div class="accordion-item"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseREGRESSIONES" aria-controls="collapseREGRESSIONES"><h6 class="accordion-header">' + getDataTypeIcon("H") + ' A-priori regression power</h6></button><div id="collapseREGRESSIONES" class="accordion-collapse collapse"><div class="accordion-body bg-light" id="regressionPowerBody"></div></div></div></div>';

			$("#power").append(resultStr);
			appendPowerTabs("#regressionPowerBody", "regression", overviewHtml, formulaHtml, getRegressionRCode());
			renderPowerChart("powerChartRegression", curvePoints, regressionResult.minimumN || participants, participants, getTargetPower());
			$("#resultsPanel").show();
		}

		function showTTestPowerAndEffectSizes(tTestResult, participants) {
			$("#rowES").show();
			let selectedResult = tTestResult.selectedResult || tTestResult.effectRow;
			selectedResult.label = selectedResult.label || (studyDesign.withinIVs.length > 0 ? "Paired t-test" : "Independent t-test");
			let requiredN = participants;
			let summaryHtml = buildPowerSummary(tTestResult.minimumN, requiredN, studyDesign.withinIVs.length > 0 ? "Paired t-test" : "Independent t-test");
			let curvePoints = buildConsistentCurvePoints(
				tTestResult.curvePoints.slice(),
				requiredN,
				[computeTTestPowerAtSampleSize(requiredN, resolveEffectSizes().cohensD, studyDesign.withinIVs.length > 0, getCurrentWithinCorrelation())]
			);

			let tableHtml = '<div class="chart-shell" style="height: 320px;"><canvas id="powerChartTTest"></canvas></div>' +
				'<div class="table-responsive mt-3"><table class="table table-striped table-bordered"><thead><tr><th>Statistic</th><th>Value</th></tr></thead><tbody>' +
				'<tr><td>Power</td><td>' + roundTo(selectedResult.power * 100, 1) + '%</td></tr>' +
				'<tr><td>Cohen\'s d</td><td>' + roundTo(selectedResult.cohenD, 3) + '</td></tr>' +
				'<tr><td>Cohen\'s f</td><td>' + roundTo(selectedResult.cohenF, 3) + '</td></tr>' +
				'<tr><td>Partial eta squared</td><td>' + roundTo(selectedResult.partialEtaSquared, 3) + '</td></tr>' +
				'<tr><td>df1 / df2</td><td>' + selectedResult.df1 + ' / ' + selectedResult.df2 + '</td></tr>' +
				'</tbody></table></div>';
			let formulaHtml = "<p><code>Power = 1 - F<sub>ncf</sub>(F<sub>crit</sub>; df1 = 1, df2 = " + selectedResult.df2 + ", &lambda; = " + roundTo(selectedResult.lambda, 3) + ")</code></p>";
			let resultStr = '<div class="accordion"><div class="accordion-item"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseTTESTES" aria-controls="collapseTTESTES"><h6 class="accordion-header">' + getDataTypeIcon("H") + ' A-priori t-test power</h6></button><div id="collapseTTESTES" class="accordion-collapse collapse"><div class="accordion-body bg-light" id="ttestPowerBody"></div></div></div></div>';

			$("#power").append(resultStr);
			appendPowerTabs("#ttestPowerBody", "ttest", summaryHtml + tableHtml, formulaHtml, getNominalRCode());
			renderPowerChart("powerChartTTest", curvePoints, tTestResult.minimumN, requiredN, getTargetPower());
			$("#resultsPanel").show();
		}

		function showANOVAPowerAndEffectSizes(anovaResult, participants){
			$("#rowES").show();
			let effectSizes = resolveEffectSizes();
			let selectedPower = StudyPowerEngine.estimateAnovaPower({
				factors: getNominalFactors(),
				effectSizeF: effectSizes.cohensF,
				alpha: 0.05,
				totalParticipants: participants,
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
			let controllingRow = selectedRows.reduce(function(best, row) {
				if(!best || row.power < best.power) {
					return row;
				}

				return best;
			}, null);
			let requiredN = participants;
			let curvePoints = buildConsistentCurvePoints(anovaResult.curvePoints.slice(), requiredN, selectedRows);

			let overviewHtml = buildPowerSummary(anovaResult.minimumN, requiredN, controllingRow ? controllingRow.label : "N/A") +
				'<div class="chart-shell" style="height: 340px;"><canvas id="powerChartAnova"></canvas></div>' +
				'<div class="table-responsive mt-3"><table id="powerOutputTable" class="table table-striped table-bordered"><thead><tr><th>Effect</th><th>Power</th><th>Cohen\'s f</th><th>Partial eta squared</th><th>df1</th><th>df2</th></tr></thead><tbody>' +
				selectedRows.map(function(row) {
					return "<tr><td>" + row.label + "</td><td>" + roundTo(row.power * 100, 1) + "%</td><td>" + roundTo(row.cohenF, 3) + "</td><td>" + roundTo(row.partialEtaSquared, 3) + "</td><td>" + row.df1 + "</td><td>" + row.df2 + "</td></tr>";
				}).join("") +
				'</tbody></table></div>';
			let formulaHtml = controllingRow ? "<p>" + buildAnovaPowerFormula(controllingRow, requiredN) + "</p>" : "<p>No ANOVA effect available.</p>";
			let resultStr = '<div class="accordion"><div class="accordion-item"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseANOVAES" aria-controls="collapseANOVAES"><h6 class="accordion-header">' + getDataTypeIcon("H") + ' A-priori ANOVA power</h6></button><div id="collapseANOVAES" class="accordion-collapse collapse"><div class="accordion-body bg-light" id="anovaPowerBody"></div></div></div></div>';

			$("#power").append(resultStr);
			appendPowerTabs("#anovaPowerBody", "anova", overviewHtml, formulaHtml, getNominalRCode());
			renderPowerChart("powerChartAnova", curvePoints, anovaResult.minimumN, requiredN, getTargetPower());
			$("#resultsPanel").show();
		}

})();


