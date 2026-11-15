/** 触发一次浏览器下载；APK 外壳里由注入脚本接管，落到系统「下载」目录 */
export const downloadBlob = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
