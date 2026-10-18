#!/usr/bin/env bash
set -euo pipefail

# Scripts paths relative to repository root
declare -A TEMPLATES
TEMPLATES[bridge]="packages/mcp/scripts/swal-bridge.service"
TEMPLATES[radar]="radar/swal-radar.service.in"
TEMPLATES[guardian]="scripts/guardian/risk-guardian.service"

DEFAULT_DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ACTION="print"
DEST_DIR="${DEFAULT_DEST}"
FORCE=0
ENABLE=0
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
declare -a ONLY_SERVICES=()

print_help() {
    cat << 'EOF'
Usage: install-linux-services.sh [OPTIONS]

Options:
  --print           Render all unit files to stdout separated by headers (default)
  --install         Install units to destination directory and create env templates
  --dest DIR        Destination for units (default: $XDG_CONFIG_HOME/systemd/user)
  --only NAME       Only process bridge, radar, or guardian (repeatable)
  --force           Overwrite existing unit files
  --enable          Run daemon-reload and enable --now after installation
  --repo-dir DIR    Repository root (default: auto-detected)
  -h, --help        Show this help message
EOF
}

# Argument parsing using standard while loop
while [[ $# -gt 0 ]]; do
    case "$1" in
        --print)
            ACTION="print"
            shift
            ;;
        --install)
            ACTION="install"
            shift
            ;;
        --dest)
            DEST_DIR="$2"
            shift 2
            ;;
        --only)
            ONLY_SERVICES+=("$2")
            shift 2
            ;;
        --force)
            FORCE=1
            shift
            ;;
        --enable)
            ENABLE=1
            shift
            ;;
        --repo-dir)
            REPO_DIR="$2"
            shift 2
            ;;
        -h|--help)
            print_help
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [[ ${#ONLY_SERVICES[@]} -eq 0 ]]; then
    ONLY_SERVICES=("bridge" "radar" "guardian")
fi

render_service() {
    local name="$1"
    local template_path="${REPO_DIR}/${TEMPLATES[$name]}"

    if [[ ! -f "$template_path" ]]; then
        echo "Error: Template not found: $template_path" >&2
        return 1
    fi

    local content
    content=$(cat "$template_path")

    # Common replacements
    # Ensure node and python3 do not point to nixos absolute paths
    content="${content//\/run\/current-system\/sw\/bin\/node/\/usr\/bin\/env node}"
    content="${content//\/run\/current-system\/sw\/bin\/python3/\/usr\/bin\/env python3}"

    if [[ "$name" == "bridge" ]]; then
        # Replace %h/proyectosSWAL/synapse/swal-trade with REPO_DIR
        content="${content//%h\/proyectosSWAL\/synapse\/swal-trade/$REPO_DIR}"
    elif [[ "$name" == "guardian" ]]; then
        # Replace %h/swal-trade with REPO_DIR
        content="${content//%h\/swal-trade/$REPO_DIR}"
        # Env file path should be left as %h as per systemd user service best practice
    elif [[ "$name" == "radar" ]]; then
        # Replace @REPO_DIR@ with REPO_DIR
        content="${content//@REPO_DIR@/$REPO_DIR}"
        # Replace @ENV_FILE@ with %h systemd specifier
        content="${content//@ENV_FILE@/%h/.config/swal-trade/radar.env}"
    fi

    echo "$content"
}

create_env_template() {
    local env_file="$1"
    local content="$2"

    if [[ ! -f "$env_file" ]]; then
        mkdir -p "$(dirname "$env_file")"
        echo -e "$content" > "$env_file"
        chmod 600 "$env_file"
        echo "Created environment template: $env_file"
    else
        echo "Kept existing environment file: $env_file"
    fi
}

install_services() {
    mkdir -p "$DEST_DIR"
    for name in "${ONLY_SERVICES[@]}"; do
        local unit_file="$DEST_DIR"
        if [[ "$name" == "bridge" ]]; then
            unit_file="$DEST_DIR/swal-bridge.service"
        elif [[ "$name" == "guardian" ]]; then
            unit_file="$DEST_DIR/risk-guardian.service"
        elif [[ "$name" == "radar" ]]; then
            unit_file="$DEST_DIR/swal-radar.service"
        fi

        if [[ -f "$unit_file" && "$FORCE" -eq 0 ]]; then
            echo "Skipped existing unit file: $unit_file (use --force to overwrite)"
            continue
        fi

        render_service "$name" > "$unit_file"
        echo "Installed unit file: $unit_file"
    done

    # Env templates
    if [[ " ${ONLY_SERVICES[*]} " =~ " radar " ]]; then
        create_env_template "${HOME}/.config/swal-trade/radar.env" "#BINANCE_API_KEY=\n#BINANCE_API_SECRET=\n#RADAR_SYNC_USER_TRADES=\n#RADAR_PORT="
    fi
    if [[ " ${ONLY_SERVICES[*]} " =~ " guardian " ]]; then
        create_env_template "${HOME}/.config/risk-guardian.env" "#BINANCE_API_KEY=\n#BINANCE_API_SECRET="
    fi
}

print_services() {
    local first=1
    for name in "${ONLY_SERVICES[@]}"; do
        if [[ "$first" -eq 1 ]]; then
            first=0
        else
            echo ""
            echo "---"
            echo ""
        fi
        echo "### Service: $name"
        render_service "$name"
    done
}

enable_services() {
    local enable_units=()
    for name in "${ONLY_SERVICES[@]}"; do
        if [[ "$name" == "bridge" ]]; then
            enable_units+=("swal-bridge.service")
        elif [[ "$name" == "guardian" ]]; then
            enable_units+=("risk-guardian.service")
        elif [[ "$name" == "radar" ]]; then
            enable_units+=("swal-radar.service")
        fi
    done

    if command -v systemctl >/dev/null 2>&1; then
        echo "Running: systemctl --user daemon-reload"
        systemctl --user daemon-reload
        echo "Running: systemctl --user enable --now ${enable_units[*]}"
        systemctl --user enable --now "${enable_units[@]}"
        echo "Note: If you want these services to start on boot without logging in, run:"
        echo "  loginctl enable-linger \$USER"
    else
        echo "systemctl not found. To enable services, run:"
        echo "  systemctl --user daemon-reload"
        echo "  systemctl --user enable --now ${enable_units[*]}"
        echo "  loginctl enable-linger \$USER"
    fi
}

if [[ "$ACTION" == "print" ]]; then
    print_services
elif [[ "$ACTION" == "install" ]]; then
    install_services
    if [[ "$ENABLE" -eq 1 ]]; then
        enable_services
    fi
fi
