alpha_level <- 0.05
target_power <- 0.80
within_correlation <- 0.5

mixed_weight <- function(repeated_measure_cells, within_correlation = 0.5) {
  base_weight <- 0.1513622 + 0.673213 * repeated_measure_cells - 0.0393958 * repeated_measure_cells^2
  max(0.75, base_weight) * (0.5 / max(1 - within_correlation, 0.05))
}

between_weight <- function(between_cells) {
  max(0.5, 0.5566116 + 0.0283437 * between_cells - 0.00218684 * between_cells^2)
}

predict_sample_size <- function(effect_size_f, between_levels, within_levels) {
  power_at <- function(sample_size) {
    if (between_levels == 1 && within_levels > 1) {
      df1 <- within_levels - 1
      df2 <- max(1, (sample_size - 1) * df1)
      lambda <- effect_size_f^2 * sample_size * (within_levels / (1 - within_correlation))
    } else if (within_levels == 1 && between_levels > 1) {
      df1 <- between_levels - 1
      df2 <- max(1, sample_size - between_levels)
      lambda <- effect_size_f^2 * sample_size * between_weight(between_levels)
    } else {
      df1 <- (between_levels - 1) * (within_levels - 1)
      df2 <- max(1, (sample_size - between_levels) * df1)
      lambda <- effect_size_f^2 * sample_size * mixed_weight(within_levels, within_correlation)
    }

    critical_value <- qf(1 - alpha_level, df1, df2)
    1 - pf(critical_value, df1, df2, ncp = lambda)
  }

  lower <- max(4, between_levels + 2)
  upper <- lower

  while (power_at(upper) < target_power && upper < 4000) {
    upper <- upper * 2
  }

  best <- upper
  left <- lower
  right <- upper

  while (left <= right) {
    middle <- floor((left + right) / 2)
    if (power_at(middle) >= target_power) {
      best <- middle
      right <- middle - 1
    } else {
      left <- middle + 1
    }
  }

  best
}

root_dir <- normalizePath(".", mustWork = TRUE)
testdata_dir <- file.path(root_dir, "testdata")

if (!dir.exists(testdata_dir)) {
  cat("No local testdata directory found. Validation skipped.\n")
  quit(save = "no", status = 0)
}

reference_files <- list.files(testdata_dir, pattern = "^ANOVA-FTest-\\d+b\\d+w\\.txt$", full.names = TRUE)

if (length(reference_files) == 0) {
  cat("No reference files found.\n")
  quit(save = "no", status = 0)
}

validation_rows <- data.frame(
  design = character(),
  effect_size_f = numeric(),
  expected_n = numeric(),
  predicted_n = numeric(),
  stringsAsFactors = FALSE
)

for (reference_file in reference_files) {
  file_name <- basename(reference_file)
  capture <- regmatches(file_name, regexec("ANOVA-FTest-(\\d+)b(\\d+)w\\.txt", file_name))[[1]]
  between_levels <- as.integer(capture[2])
  within_levels <- as.integer(capture[3])
  reference_table <- read.table(reference_file, header = TRUE, sep = "", stringsAsFactors = FALSE)

  predicted_values <- vapply(
    reference_table$eff_size_f,
    function(effect_size_f) predict_sample_size(effect_size_f, between_levels, within_levels),
    numeric(1)
  )

  validation_rows <- rbind(
    validation_rows,
    data.frame(
      design = paste0(between_levels, "b", within_levels, "w"),
      effect_size_f = reference_table$eff_size_f,
      expected_n = reference_table$sample_size,
      predicted_n = predicted_values,
      stringsAsFactors = FALSE
    )
  )
}

absolute_error <- abs(validation_rows$predicted_n - validation_rows$expected_n)
validation_rows$error <- validation_rows$predicted_n - validation_rows$expected_n

cat("Validated", nrow(validation_rows), "rows against local reference exports.\n")
cat("Mean abs error:", round(mean(absolute_error), 2), "\n")
cat("Max abs error:", round(max(absolute_error), 2), "\n")
cat("\nWorst rows:\n")
print(head(validation_rows[order(-absolute_error), ], 10), row.names = FALSE)
