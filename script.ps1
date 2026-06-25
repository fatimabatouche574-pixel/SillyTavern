
$url = 'https://nightly.link/fatimabatouche574-pixel/SillyTavern/workflows/build-apk.yml/release/SillyTavern-Android-APK.zip'
$destZip = 'C:\Users\admin\Desktop\SillyTavern-Android-APK.zip'
$destDir = 'C:\Users\admin\Desktop\SillyTavern-APK'

for ($i=0; $i -lt 30; $i++) {
    try {
        Invoke-WebRequest -Uri $url -OutFile $destZip -ErrorAction Stop
        if (Test-Path $destZip) {
            Expand-Archive -Path $destZip -DestinationPath $destDir -Force
            Remove-Item $destZip
            Write-Host 'APK successfully downloaded and extracted to Desktop!'
            exit 0
        }
    } catch {
        Write-Host 'Artifact not ready yet, waiting 30 seconds...'
    }
    Start-Sleep -Seconds 30
}
Write-Host 'Timed out waiting for artifact'

