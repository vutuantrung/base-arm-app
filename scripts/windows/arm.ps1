param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('upload','activate','start','stop','restart','inspect','list','logs')]
    [string]$Action,
    [string]$ApplicationId,
    [string]$Version,
    [string]$PackagePath,
    [ValidateSet('stdout','stderr','diagnostics')]
    [string]$Stream = 'stderr',
    [string]$Base = 'http://127.0.0.1:3300',
    [string]$Token = $env:ARM_MANAGEMENT_TOKEN
)
$ErrorActionPreference = 'Stop'
if (-not $Token) { throw 'Set $env:ARM_MANAGEMENT_TOKEN or pass -Token.' }
$Base = $Base.TrimEnd('/')
$headers = @{ Authorization = "Bearer $Token" }
if ($Action -eq 'upload') {
    if (-not $PackagePath) { throw '-PackagePath is required.' }
    $file = Get-Item -LiteralPath $PackagePath
    if ($file.PSIsContainer) { throw 'Package must be a ZIP file.' }
    Invoke-RestMethod -Method Post -Uri "$Base/deployments/upload" -Headers $headers -ContentType 'application/zip' -InFile $file.FullName
    return
}
if ($Action -eq 'list') {
    Invoke-RestMethod -Method Get -Uri "$Base/applications" -Headers $headers
    return
}
if ($ApplicationId -cnotmatch '^[A-Za-z][A-Za-z0-9_.-]{0,63}$') { throw 'Invalid application ID.' }
$url = "$Base/applications/$ApplicationId"
switch ($Action) {
    'inspect' { Invoke-RestMethod -Method Get -Uri $url -Headers $headers }
    'logs' { Invoke-RestMethod -Method Get -Uri "$Base/runtime/processes/$ApplicationId/logs/$Stream" -Headers $headers }
    'activate' {
        if (-not $Version) { throw '-Version is required.' }
        Invoke-RestMethod -Method Post -Uri "$url/activate" -Headers $headers -ContentType 'application/json' -Body (@{version=$Version} | ConvertTo-Json -Compress)
    }
    default { Invoke-RestMethod -Method Post -Uri "$url/$Action" -Headers $headers }
}
