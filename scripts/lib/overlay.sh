# Sourced by the host scripts: reads the owner's $APP_DIR/overlay/scripts.env (open source O1).
# Each line is KEY=value (quotes around the value and Windows line ends allowed), read as text and never run; a blank
# line or # comment is skipped, anything else ignored.
# A value already in the environment wins, so a run by hand can always override the file.
brain_overlay() {
  local file="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/overlay/scripts.env" line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    [[ "$line" == *=* ]] || continue
    line="${line%$'\r'}"
    key="${line%%=*}"
    value="${line#*=}"
    # One pair of surrounding quotes is not part of the value (COPY_DIRS="/a /b").
    if [[ ${#value} -ge 2 && ( ( "${value:0:1}" == '"' && "${value: -1}" == '"' ) || ( "${value:0:1}" == "'" && "${value: -1}" == "'" ) ) ]]; then
      value="${value:1:${#value}-2}"
    fi
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    [ -n "${!key+x}" ] && continue
    export "$key=$value"
  done < "$file"
}
