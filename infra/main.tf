terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  default_tags {
    tags = {
      Project     = "lastfm-scrobble-cleaner"
      Environment = "prod"
      ManagedBy   = "terraform"
      Repository  = "https://github.com/essoen/lastfm-scrobble-cleaner"
    }
  }
}

# --- Secrets Manager ---

resource "aws_secretsmanager_secret" "lastfm_credentials" {
  name        = "lastfm-scrobble-cleaner/credentials"
  description = "Last.fm API credentials for scrobble cleaner"
}

# --- DynamoDB ---

resource "aws_dynamodb_table" "duration_cache" {
  name         = "lastfm-track-durations"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }
}

# --- Lambda ---

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "lastfm-cleaner-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "lambda_permissions" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.lastfm_credentials.arn]
  }
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.duration_cache.arn]
  }
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
  }
}

resource "aws_iam_role_policy" "lambda_permissions" {
  name   = "lastfm-cleaner-permissions"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_permissions.json
}

resource "aws_lambda_function" "cleaner" {
  function_name = "lastfm-scrobble-cleaner"
  role          = aws_iam_role.lambda.arn
  handler       = "handler.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  timeout       = 300
  memory_size   = 256
  filename      = "${path.module}/../dist/lambda.zip"

  source_code_hash = filebase64sha256("${path.module}/../dist/lambda.zip")

  environment {
    variables = {
      SECRET_ARN     = aws_secretsmanager_secret.lastfm_credentials.arn
      DURATION_TABLE = aws_dynamodb_table.duration_cache.name
      SNS_TOPIC_ARN  = aws_sns_topic.alerts.arn
      DRY_RUN        = "true"
    }
  }
}

# --- EventBridge (daily at 02:00 UTC) ---

resource "aws_cloudwatch_event_rule" "daily" {
  name                = "lastfm-cleaner-daily"
  schedule_expression = "cron(0 2 * * ? *)"
}

resource "aws_cloudwatch_event_target" "lambda" {
  rule = aws_cloudwatch_event_rule.daily.name
  arn  = aws_lambda_function.cleaner.arn
}

resource "aws_lambda_permission" "eventbridge" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cleaner.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.daily.arn
}

# --- SNS + CloudWatch Alarm ---

resource "aws_sns_topic" "alerts" {
  name = "lastfm-cleaner-alerts"
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "lastfm-cleaner-errors"
  alarm_description   = "Scrobble cleaner Lambda failed"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    FunctionName = aws_lambda_function.cleaner.function_name
  }
}

# --- Outputs ---

output "function_name" {
  value = aws_lambda_function.cleaner.function_name
}

output "secret_arn" {
  value = aws_secretsmanager_secret.lastfm_credentials.arn
}

output "alert_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
