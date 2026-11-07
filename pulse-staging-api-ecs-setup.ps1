# ======================================================================
#  Pulse - staging ECS Fargate setup for the Pressto API (LoopBack)
#  Run:  powershell -ExecutionPolicy Bypass -File .\pulse-staging-api-ecs-setup.ps1
#  Reads app settings from a STAGING env file (default .env.staging) - never your live .env.
#  Reuses the VPC, cluster, ALB and security groups from the customer-web setup.
#  Safe to re-run: existing resources are reused. The secret IS overwritten from the env file.
# ======================================================================
param([string]$EnvFile = ".env.staging")

# ---------- 1. SETTINGS: check these before running ----------
$Region       = "ap-south-1"
$Account      = "176377883887"
$App          = "api"                          # container name (Bitbucket CONTAINER_NAME)
$Port         = 3000
$HealthPath   = "/ping"
$HostName     = "staging-pulse-api.technorthstar.com"                             # REQUIRED: API hostname on the shared ALB
$RulePriority = 20                             # ALB listener rule priority (must be unused)
$DbResourceId = "cluster-5S6SWO4V3NFB5EAU4F2XD4FZWE"   # Aurora cluster resource id (IAM DB login)

# These keys go to Secrets Manager; every other key in the env file becomes a plain container env var.
$SecretKeys = @("JWT_SECRET","PG_PASSWORD","EMAIL_PASSWORD","RAZORPAY_KEY_SECRET","RAZORPAY_WEBHOOK_SECRET",
                "WHATSAPP_ACCESS_TOKEN","ORDER_SUMMARY_URL_SIGNING_SECRET","TATA_WABA_API_KEY","GOOGLE_GEOCODING_API_KEY")
# Set by this script / the image, ignored if present in the env file.
$SkipKeys   = @("PORT","HOST","FIREBASE_SERVICE_ACCOUNT_PATH")

# ---------- names ----------
$Cluster    = "pulse-staging-cluster"
$Family     = "pulse-staging-api"
$Service    = "pulse-staging-api-service"
$Repo       = "pulse/staging/api"
$SecretName = "pulse/staging/api"
$LogGroup   = "/ecs/pulse-staging-api"
$ExecRole   = "pulse-staging-ecs-execution"
$TaskRole   = "pulse-staging-ecs-task"
$TgName     = "pulse-staging-api-tg"
$AlbName    = "pulse-staging-alb"
$VpcName    = "pulse-staging-vpc"
$AlbSgName  = "pulse-staging-alb-sg"
$AppSgName  = "pulse-staging-api-sg"
$Image      = "$Account.dkr.ecr.$Region.amazonaws.com/${Repo}:latest"
$env:AWS_DEFAULT_REGION = $Region
$Work = Join-Path $env:TEMP "pulse-ecs-api"; New-Item -ItemType Directory -Force -Path $Work | Out-Null

function Save-Json($name, $obj) {
  $path = Join-Path $Work $name
  [System.IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 20))
  return "file://$($path -replace '\\','/')"
}
function Check($what) {
  if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: $what" -ForegroundColor Red; exit 1 }
  Write-Host "OK: $what" -ForegroundColor Green
}

if (-not $HostName) { Write-Host "Set `$HostName (API hostname) before running." -ForegroundColor Red; exit 1 }
if (-not (Test-Path $EnvFile)) { Write-Host "Env file '$EnvFile' not found. Create it from .env.example with STAGING values." -ForegroundColor Red; exit 1 }

# ---------- 2. READ ENV FILE ----------
$Plain = [ordered]@{}; $Secret = [ordered]@{}
foreach ($line in Get-Content $EnvFile) {
  if ($line -match '^\s*#' -or $line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { continue }
  $k = $Matches[1]; $v = $Matches[2].Trim().Trim('"').Trim("'")
  if ($SkipKeys -contains $k -or $v -eq "") { continue }
  if ($SecretKeys -contains $k) { $Secret[$k] = $v } else { $Plain[$k] = $v }
}
foreach ($k in @("PG_HOST","PG_USER","JWT_SECRET")) {
  if (-not ($Plain.Contains($k) -or $Secret.Contains($k))) { Write-Host "Missing required key $k in $EnvFile" -ForegroundColor Red; exit 1 }
}
Write-Host "OK: $($Plain.Count) plain keys, $($Secret.Count) secret keys read from $EnvFile" -ForegroundColor Green

# ---------- 3. LOOKUPS ----------
$VpcId = aws ec2 describe-vpcs --filters "Name=tag:Name,Values=$VpcName" --query "Vpcs[0].VpcId" --output text
if (-not $VpcId -or $VpcId -eq "None") { Write-Host "VPC $VpcName not found" -ForegroundColor Red; exit 1 }
$Subnets = (aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VpcId" "Name=tag:Name,Values=*public*" `
            --query "Subnets[].SubnetId" --output text) -split '\s+' | Where-Object { $_ }
if ($Subnets.Count -lt 2) { Write-Host "Need 2 public subnets in $VpcName, found: $Subnets" -ForegroundColor Red; exit 1 }
function Get-SgId($name) {
  aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VpcId" "Name=group-name,Values=$name" `
    --query "SecurityGroups[0].GroupId" --output text
}
$AlbSg = Get-SgId $AlbSgName; $AppSg = Get-SgId $AppSgName
if ($AlbSg -eq "None" -or $AppSg -eq "None") { Write-Host "Run the customer-web setup first (ALB/app security groups missing)" -ForegroundColor Red; exit 1 }
aws ec2 authorize-security-group-ingress --group-id $AppSg --protocol tcp --port $Port --source-group $AlbSg 2>$null | Out-Null
$AlbArn = aws elbv2 describe-load-balancers --names $AlbName --query "LoadBalancers[0].LoadBalancerArn" --output text
if (-not $AlbArn -or $AlbArn -eq "None") { Write-Host "ALB $AlbName not found" -ForegroundColor Red; exit 1 }
$AlbDns = aws elbv2 describe-load-balancers --load-balancer-arns $AlbArn --query "LoadBalancers[0].DNSName" --output text
Write-Host "OK: VPC $VpcId, ALB $AlbName, security groups" -ForegroundColor Green

# ---------- NETWORK: private subnets + NAT gateway (created once, reused by all three scripts) ----------
$PrivSubnets = (aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VpcId" "Name=tag:Name,Values=*private*" `
                --query "Subnets[].SubnetId" --output text) -split '\s+' | Where-Object { $_ }
if ($PrivSubnets.Count -lt 2) { Write-Host "Need 2 private subnets in $VpcName, found: $PrivSubnets" -ForegroundColor Red; exit 1 }
$NatId = aws ec2 describe-nat-gateways --filter "Name=vpc-id,Values=$VpcId" "Name=state,Values=available,pending" `
         --query "NatGateways[0].NatGatewayId" --output text
if (-not $NatId -or $NatId -eq "None") {
  $EipAlloc = aws ec2 allocate-address --domain vpc --query AllocationId --output text
  $NatId = aws ec2 create-nat-gateway --subnet-id $Subnets[0] --allocation-id $EipAlloc `
    --tag-specifications "ResourceType=natgateway,Tags=[{Key=Name,Value=pulse-staging-nat}]" --query "NatGateway.NatGatewayId" --output text
  Check "NAT gateway $NatId requested"
  Write-Host "Waiting for the NAT gateway..."
  aws ec2 wait nat-gateway-available --nat-gateway-ids $NatId
}
$PrivRts = (aws ec2 describe-route-tables --filters "Name=vpc-id,Values=$VpcId" "Name=association.subnet-id,Values=$($PrivSubnets -join ',')" `
            --query "RouteTables[].RouteTableId" --output text) -split '\s+' | Where-Object { $_ }
foreach ($rt in $PrivRts) { aws ec2 create-route --route-table-id $rt --destination-cidr-block 0.0.0.0/0 --nat-gateway-id $NatId 2>$null | Out-Null }
Write-Host "OK: NAT $NatId, private subnets $($PrivSubnets -join ', ') routed through it" -ForegroundColor Green

# ---------- REDIS (ElastiCache, private subnets, encrypted) ----------
$RedisId = "pulse-staging-redis"; $RedisNodeType = "cache.t4g.micro"
$RedisSubnetGroup = "pulse-staging-redis-subnets"; $RedisSgName = "pulse-staging-redis-sg"
$RedisSg = Get-SgId $RedisSgName
if ($RedisSg -eq "None") {
  $RedisSg = aws ec2 create-security-group --group-name $RedisSgName --description "Pulse staging Redis" --vpc-id $VpcId --query GroupId --output text
}
aws ec2 authorize-security-group-ingress --group-id $RedisSg --protocol tcp --port 6379 --source-group $AppSg 2>$null | Out-Null
aws elasticache describe-cache-subnet-groups --cache-subnet-group-name $RedisSubnetGroup 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  aws elasticache create-cache-subnet-group --cache-subnet-group-name $RedisSubnetGroup `
    --cache-subnet-group-description "Pulse staging Redis private subnets" --subnet-ids $PrivSubnets | Out-Null
  Check "Redis subnet group created"
}
aws elasticache describe-replication-groups --replication-group-id $RedisId 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  aws elasticache create-replication-group --replication-group-id $RedisId --replication-group-description "Pulse staging Redis" `
    --engine redis --cache-node-type $RedisNodeType --num-cache-clusters 1 --cache-subnet-group-name $RedisSubnetGroup `
    --security-group-ids $RedisSg --transit-encryption-enabled --at-rest-encryption-enabled | Out-Null
  Check "Redis $RedisId requested"
}
Write-Host "Waiting for Redis (can take 5-10 minutes)..."
aws elasticache wait replication-group-available --replication-group-id $RedisId
$RedisEndpoint = aws elasticache describe-replication-groups --replication-group-id $RedisId --query "ReplicationGroups[0].NodeGroups[0].PrimaryEndpoint.Address" --output text
$Plain["REDIS_URL"] = "rediss://${RedisEndpoint}:6379"
Write-Host "OK: Redis $RedisEndpoint (allowed from the API security group only)" -ForegroundColor Green

# ---------- 4. ECR + LOG GROUP ----------
aws ecr describe-repositories --repository-names $Repo 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  aws ecr create-repository --repository-name $Repo --image-scanning-configuration scanOnPush=true | Out-Null
  Check "ECR repository $Repo created"
} else { Write-Host "OK: ECR repository $Repo exists" -ForegroundColor Green }
aws logs create-log-group --log-group-name $LogGroup 2>$null
aws logs put-retention-policy --log-group-name $LogGroup --retention-in-days 14
Check "log group $LogGroup"

# ---------- 5. SECRET ----------
$secretFile = Save-Json "secret.json" $Secret
$SecretArn = aws secretsmanager describe-secret --secret-id $SecretName --query ARN --output text 2>$null
if (-not $SecretArn -or $LASTEXITCODE -ne 0) {
  $SecretArn = aws secretsmanager create-secret --name $SecretName --secret-string $secretFile --query ARN --output text
  Check "secret $SecretName created"
} else {
  aws secretsmanager put-secret-value --secret-id $SecretName --secret-string $secretFile | Out-Null
  Check "secret $SecretName updated from $EnvFile"
}

# ---------- 6a. TASK ROLE: IAM DATABASE LOGIN ----------
$dbUser = $Plain["PG_USER"]
$dbConnect = Save-Json "db-connect.json" @{
  Version = "2012-10-17"
  Statement = @(@{ Effect = "Allow"; Action = "rds-db:connect"
    Resource = "arn:aws:rds-db:${Region}:${Account}:dbuser:$DbResourceId/$dbUser" })
}
aws iam put-role-policy --role-name $TaskRole --policy-name rds-db-connect-api --policy-document $dbConnect
Check "task role can IAM-login to the database as $dbUser"

# ---------- 6b. EXECUTION ROLE ACCESS TO THE SECRET ----------
$readSecret = Save-Json "exec-secret.json" @{
  Version = "2012-10-17"
  Statement = @(@{ Effect = "Allow"; Action = "secretsmanager:GetSecretValue"; Resource = $SecretArn })
}
aws iam put-role-policy --role-name $ExecRole --policy-name read-api-secret --policy-document $readSecret
Check "execution role can read $SecretName"
Start-Sleep -Seconds 10

# ---------- 7. TARGET GROUP + LISTENER RULE ----------
$TgArn = aws elbv2 describe-target-groups --names $TgName --query "TargetGroups[0].TargetGroupArn" --output text 2>$null
if (-not $TgArn -or $LASTEXITCODE -ne 0) {
  $TgArn = aws elbv2 create-target-group --name $TgName --protocol HTTP --port $Port --vpc-id $VpcId `
    --target-type ip --health-check-path $HealthPath --health-check-interval-seconds 15 `
    --healthy-threshold-count 2 --query "TargetGroups[0].TargetGroupArn" --output text
  Check "target group $TgName created"
}
aws elbv2 modify-target-group-attributes --target-group-arn $TgArn --attributes Key=deregistration_delay.timeout_seconds,Value=30 | Out-Null

$ListenerArn = aws elbv2 describe-listeners --load-balancer-arn $AlbArn --query "Listeners[?Port==``443``].ListenerArn | [0]" --output text
if (-not $ListenerArn -or $ListenerArn -eq "None") {
  $ListenerArn = aws elbv2 describe-listeners --load-balancer-arn $AlbArn --query "Listeners[?Port==``80``].ListenerArn | [0]" --output text
}
$RuleArn = aws elbv2 describe-rules --listener-arn $ListenerArn `
  --query "Rules[?Conditions[?Field=='host-header' && contains(Values, '$HostName')]].RuleArn | [0]" --output text
if ($RuleArn -and $RuleArn -ne "None") {
  aws elbv2 modify-rule --rule-arn $RuleArn --actions "Type=forward,TargetGroupArn=$TgArn" | Out-Null
  Check "listener rule for $HostName updated"
} else {
  aws elbv2 create-rule --listener-arn $ListenerArn --priority $RulePriority `
    --conditions "Field=host-header,Values=$HostName" --actions "Type=forward,TargetGroupArn=$TgArn" | Out-Null
  Check "listener rule for $HostName created (priority $RulePriority)"
}

# ---------- 8. TASK DEFINITION ----------
$envList    = @($Plain.Keys | ForEach-Object { @{ name = $_; value = $Plain[$_] } }) + @(@{ name = "NODE_ENV"; value = "production" })
$secretRefs = @($Secret.Keys | ForEach-Object { @{ name = $_; valueFrom = "$($SecretArn):$($_)::" } })
$taskDef = Save-Json "taskdef.json" @{
  family = $Family
  networkMode = "awsvpc"
  requiresCompatibilities = @("FARGATE")
  cpu = "512"; memory = "1024"
  runtimePlatform = @{ cpuArchitecture = "X86_64"; operatingSystemFamily = "LINUX" }
  executionRoleArn = "arn:aws:iam::${Account}:role/$ExecRole"
  taskRoleArn      = "arn:aws:iam::${Account}:role/$TaskRole"
  containerDefinitions = @(@{
    name = $App; image = $Image; essential = $true
    portMappings = @(@{ containerPort = $Port; protocol = "tcp" })
    environment = $envList
    secrets = $secretRefs
    logConfiguration = @{ logDriver = "awslogs"; options = @{
      "awslogs-group" = $LogGroup; "awslogs-region" = $Region; "awslogs-stream-prefix" = $App } }
  })
  tags = @(@{ key = "Project"; value = "pulse" }, @{ key = "Environment"; value = "staging" })
}
$TaskDefArn = aws ecs register-task-definition --cli-input-json $taskDef --query "taskDefinition.taskDefinitionArn" --output text
Check "task definition $TaskDefArn"

# ---------- 9. SERVICE ----------
# The image must be in ECR (run the Bitbucket pipeline once with ECS_SERVICE empty) or tasks fail to start.
$status = aws ecs describe-services --cluster $Cluster --services $Service --query "services[0].status" --output text 2>$null
$net = "awsvpcConfiguration={subnets=[$($PrivSubnets -join ',')],securityGroups=[$AppSg],assignPublicIp=DISABLED}"
if ($status -eq "ACTIVE") {
  aws ecs update-service --cluster $Cluster --service $Service --task-definition $TaskDefArn --network-configuration $net | Out-Null
  Check "service $Service updated"
} else {
  aws ecs create-service --cluster $Cluster --service-name $Service --task-definition $TaskDefArn `
    --desired-count 1 --launch-type FARGATE --network-configuration $net `
    --load-balancers "targetGroupArn=$TgArn,containerName=$App,containerPort=$Port" `
    --health-check-grace-period-seconds 120 `
    --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100" `
    --tags key=Project,value=pulse key=Environment,value=staging | Out-Null
  Check "service $Service created"
}

# ---------- 10. AUTO SCALING (1-2 tasks, CPU 70%) ----------
aws application-autoscaling register-scalable-target --service-namespace ecs `
  --resource-id "service/$Cluster/$Service" --scalable-dimension ecs:service:DesiredCount `
  --min-capacity 1 --max-capacity 2 | Out-Null
$scaling = Save-Json "scaling.json" @{
  TargetValue = 70.0
  PredefinedMetricSpecification = @{ PredefinedMetricType = "ECSServiceAverageCPUUtilization" }
  ScaleOutCooldown = 60; ScaleInCooldown = 120
}
aws application-autoscaling put-scaling-policy --service-namespace ecs --resource-id "service/$Cluster/$Service" `
  --scalable-dimension ecs:service:DesiredCount --policy-name cpu70 --policy-type TargetTrackingScaling `
  --target-tracking-scaling-policy-configuration $scaling | Out-Null
Check "auto scaling 1-2 tasks"

# ---------- 11. WAIT AND REPORT ----------
Write-Host "`nWaiting for the service to become stable (can take 3-10 minutes)..." -ForegroundColor Cyan
aws ecs wait services-stable --cluster $Cluster --services $Service
if ($LASTEXITCODE -ne 0) {
  Write-Host "Service not stable yet. Latest events:" -ForegroundColor Yellow
  aws ecs describe-services --cluster $Cluster --services $Service --query "services[0].events[0:5].message"
} else { Write-Host "Service is running." -ForegroundColor Green }
aws elbv2 describe-target-health --target-group-arn $TgArn --query "TargetHealthDescriptions[].TargetHealth.State"

Write-Host "`n================ DONE ================" -ForegroundColor Cyan
Write-Host "Bitbucket Staging variables -> ECR_REPOSITORY = $Repo, ECS_CLUSTER = $Cluster, ECS_SERVICE = $Service, CONTAINER_NAME = $App"
Write-Host "DNS: CNAME $HostName -> $AlbDns"
Remove-Item -Recurse -Force $Work   # temp files contain secrets
