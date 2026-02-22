/**
 * Processes JSON Schema files and extracts table data for rendering
 */
class SchemaProcessor {
    // Keywords that should not be shown as available columns
    static EXCLUDED_KEYWORDS = new Set([
        // System keywords
        '$schema', '$id', '$ref', 'properties', 'items', 'allOf', 'anyOf', 'oneOf',
        // Default column keywords that are always handled
        'name', 'description', 'type', 'enum', 'enumDescriptions',
        // Keywords consolidated into constraints column
        'required', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
        'minLength', 'maxLength', 'pattern', 'multipleOf', 'minItems', 'maxItems',
        'uniqueItems', 'minProperties', 'maxProperties'
    ]);

    constructor() {
        this.schemas = new Map();
        this.mainSchema = null;
        this.keywordUsage = new Map();
    }

    /**
     * Process multiple JSON Schema files and identify the main schema
     * @param {FileList} files - Array of JSON Schema files
     * @returns {Promise<boolean>} True if main schema was identified
     */
    async processFiles(files) {
        this.schemas.clear();
        this.mainSchema = null;
        this.keywordUsage.clear();

        // Load all schemas
        let objectSchemaCandidate = null;
        for (const file of files) {
            const text = await file.text();
            const schema = JSON.parse(text);

            if (schema.$id) {
                this.schemas.set(schema.$id, schema);
            } else {
                // Schema without $id - treat as potential main schema
                this.schemas.set(file.name, schema);
            }

            // Prefer a type:array dataset-level schema as the main schema.
            // Fall back to the first type:object schema found.
            if (schema.type === 'array' && schema.items) {
                this.mainSchema = schema;
            } else if (!objectSchemaCandidate && (schema.type === 'object' || schema.properties)) {
                objectSchemaCandidate = schema;
            }
        }

        // If no type:array schema found, use the best type:object candidate
        if (!this.mainSchema) {
            this.mainSchema = objectSchemaCandidate || this.schemas.values().next().value || null;
        }

        // Collect keyword usage after processing all schemas
        if (this.mainSchema) {
            this.collectKeywordUsage();
        }

        return this.mainSchema !== null;
    }

    /**
     * Resolve a JSON Schema $ref reference
     * @param {string} ref - The $ref string to resolve
     * @param {Object} baseSchema - The base schema for internal refs
     * @returns {Object|null} The resolved schema or null
     */
    resolveRef(ref, baseSchema) {
        if (ref.startsWith('#')) {
            // Internal reference
            const path = ref.substring(2).split('/');
            let current = baseSchema;
            for (const segment of path) {
                current = current[segment];
                if (!current) return null;
            }
            return current;
        } else {
            // External reference
            for (const [id, schema] of this.schemas) {
                if (id.endsWith(ref) || ref.endsWith(id)) {
                    return schema;
                }
            }
            // Try simple filename match
            return this.schemas.get(ref) || null;
        }
    }

    extractProperties(schema, category = null) {
        const result = [];

        if (schema.properties) {
            for (const [name, propSchema] of Object.entries(schema.properties)) {
                result.push({
                    category: category,
                    name: name,
                    schema: propSchema,
                    required: schema.required?.includes(name) || false
                });

                // If this property is a nested array of objects, expand its item
                // properties as additional rows grouped under a sub-category.
                if (propSchema.type === 'array' && propSchema.items?.properties) {
                    const arrayCategory = `${name} — array items`;
                    result.push(...this.extractProperties(propSchema.items, arrayCategory));
                }
            }
        }

        if (schema.allOf) {
            for (const subSchema of schema.allOf) {
                if (subSchema.$ref) {
                    const resolved = this.resolveRef(subSchema.$ref, schema);
                    if (resolved) {
                        const subCategory = resolved.title || category;
                        result.push(...this.extractProperties(resolved, subCategory));
                    }
                } else {
                    result.push(...this.extractProperties(subSchema, category));
                }
            }
        }

        return result;
    }

    collectKeywordUsage() {
        const properties = this.getTableData()?.properties || [];

        for (const prop of properties) {
            const schema = prop.schema;

            // Collect all keywords from the schema
            for (const keyword of Object.keys(schema)) {
                if (!SchemaProcessor.EXCLUDED_KEYWORDS.has(keyword)) {
                    const count = this.keywordUsage.get(keyword) || 0;
                    this.keywordUsage.set(keyword, count + 1);
                }
            }
        }
    }

    getKeywordUsageStats() {
        // Sort by usage count (descending)
        return Array.from(this.keywordUsage.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([keyword, count]) => ({ keyword, count }));
    }

    getTableData() {
        if (!this.mainSchema) return null;

        // Case 1: dataset-level array schema — resolve its item/row schema and
        // use the existing allOf/$ref resolution path.
        if (this.mainSchema.type === 'array' && this.mainSchema.items) {
            let rowSchema = this.mainSchema.items;
            if (rowSchema?.$ref) {
                const resolved = this.resolveRef(rowSchema.$ref, this.mainSchema);
                if (resolved) rowSchema = resolved;
            }
            if (!rowSchema) return null;
            return {
                title: this.mainSchema.title || rowSchema.title || 'Dataset Schema',
                description: this.mainSchema.description || rowSchema.description || '',
                properties: this.extractProperties(rowSchema)
            };
        }

        // Case 2: multiple type:object schemas uploaded directly — combine all
        // into a single table, one category per schema (no wrapper files needed).
        const objectSchemas = Array.from(this.schemas.values()).filter(
            s => s.type === 'object' || s.properties
        );
        if (objectSchemas.length > 1) {
            const allProperties = [];
            for (const schema of objectSchemas) {
                allProperties.push(...this.extractProperties(schema, schema.title || null));
            }
            const titles = objectSchemas.map(s => s.title).filter(Boolean).join(', ');
            return {
                title: 'Combined Data Dictionary',
                description: titles ? `Sections: ${titles}` : `Combined from ${objectSchemas.length} schema files`,
                properties: allProperties
            };
        }

        // Case 3: single type:object schema.
        return {
            title: this.mainSchema.title || 'Dataset Schema',
            description: this.mainSchema.description || '',
            properties: this.extractProperties(this.mainSchema)
        };
    }
}

/**
 * Manages column selection, ordering, and rendering for the data dictionary table
 */
class ColumnManager {
    constructor() {
        // Default columns that are always shown initially
        this.defaultColumns = [
            { keyword: 'name', display: 'Variable Name', width: 150 },
            { keyword: 'description', display: 'Description', width: 300 },
            { keyword: 'type', display: 'Data Type', width: 110 },
            { keyword: 'format', display: 'Format', width: 140 },
            { keyword: 'enum', display: 'Valid Values', width: 140 },
            { keyword: 'constraints', display: 'Constraints', width: 150 },
            { keyword: 'additionalInfo', display: 'Additional Info', width: 120 }
        ];

        // Default column order
        this.defaultColumnOrder = this.defaultColumns.map(c => c.keyword);

        // All possible column definitions
        this.columnDefinitions = {
            name: { display: 'Variable Name', width: 150 },
            description: { display: 'Description', width: 300 },
            type: { display: 'Data Type', width: 110 },
            enum: { display: 'Valid Values', width: 140 },
            constraints: { display: 'Constraints', width: 150 },
            additionalInfo: { display: 'Additional Info', width: 120 },
            // Additional columns that can be pulled from Additional Info
            format: { display: 'Format', width: 100 },
            default: { display: 'Default', width: 100 },
            deprecated: { display: 'Deprecated', width: 90 },
            readOnly: { display: 'Read Only', width: 90 },
            writeOnly: { display: 'Write Only', width: 90 },
            title: { display: 'Title', width: 150 },
            examples: { display: 'Examples', width: 200 }
        };

        // Keywords that are consolidated into other columns and shouldn't appear as options
        this.consolidatedKeywords = new Set([
            'required', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
            'minLength', 'maxLength', 'pattern', 'multipleOf', 'minItems', 'maxItems',
            'uniqueItems', 'minProperties', 'maxProperties', 'enumDescriptions'
        ]);

        // Currently selected columns
        this.selectedColumns = this.defaultColumns.map(c => c.keyword);

        // Track the current drag operation
        this.draggedIndex = null;
    }

    getSelectedColumns() {
        return this.selectedColumns;
    }

    setSelectedColumns(columns) {
        this.selectedColumns = columns;
    }

    moveColumn(fromIndex, toIndex) {
        if (fromIndex === toIndex) return;

        const columns = [...this.selectedColumns];
        const [movedColumn] = columns.splice(fromIndex, 1);
        columns.splice(toIndex, 0, movedColumn);

        this.selectedColumns = columns;
        return columns;
    }

    resetColumnOrder() {
        // Reset to default order, keeping only currently selected columns
        const selected = new Set(this.selectedColumns);
        this.selectedColumns = this.defaultColumnOrder.filter(col => selected.has(col));

        // Add any selected columns not in default order at the end
        for (const col of selected) {
            if (!this.defaultColumnOrder.includes(col)) {
                this.selectedColumns.push(col);
            }
        }

        return this.selectedColumns;
    }

    getColumnDefinition(keyword) {
        return this.columnDefinitions[keyword] ||
               { display: this.formatKeywordDisplay(keyword), width: 120 };
    }

    formatKeywordDisplay(keyword) {
        // Convert camelCase to Title Case
        return keyword.replace(/([A-Z])/g, ' $1')
                     .replace(/^./, str => str.toUpperCase())
                     .trim();
    }

    renderColumnSelector(keywordStats) {
        const container = document.createElement('div');
        container.className = 'column-selector-container';
        container.innerHTML = `
            <div class="column-selector-header">Customize Table Columns</div>
            <div class="column-selector-dropdown">
                <div class="column-selector-button" id="columnSelectorBtn">
                    <span>${this.selectedColumns.length} columns selected</span>
                    <span>▼</span>
                </div>
                <div class="column-selector-list" id="columnSelectorList">
                    <div class="column-selector-controls">
                        <button class="column-selector-control-btn" id="selectAllBtn">Select All</button>
                        <button class="column-selector-control-btn" id="selectNoneBtn">Select None</button>
                        <button class="column-selector-control-btn" id="selectDefaultBtn">Default</button>
                        <button class="column-selector-control-btn reset-order-btn" id="resetOrderBtn">Reset Order</button>
                    </div>
                    <div class="column-list-container" id="columnCheckboxList"></div>
                </div>
            </div>
        `;

        // Store keyword stats for later use
        this.keywordStats = keywordStats;

        // Populate checkbox list
        this.refreshColumnList(container);

        // Add event listeners
        this.attachSelectorEvents(container);

        return container;
    }

    refreshColumnList(container) {
        const checkboxList = container.querySelector('#columnCheckboxList');
        checkboxList.innerHTML = '';

        // Create a map of keyword to count
        const keywordCountMap = new Map();
        if (this.keywordStats) {
            for (const { keyword, count } of this.keywordStats) {
                keywordCountMap.set(keyword, count);
            }
        }

        // Render selected columns in their current order
        const addedKeywords = new Set();
        for (let i = 0; i < this.selectedColumns.length; i++) {
            const keyword = this.selectedColumns[i];
            const def = this.getColumnDefinition(keyword);
            const count = keyword === 'additionalInfo' ? null : keywordCountMap.get(keyword) || null;
            this.renderCheckboxItem(checkboxList, keyword, def.display, count, addedKeywords, i, true);
        }

        // Collect unselected keywords from actual schema data
        const unselectedKeywords = [];

        // First add special columns that don't come from schema keywords
        if (!addedKeywords.has('constraints')) {
            unselectedKeywords.push({ keyword: 'constraints', count: null });
        }
        if (!addedKeywords.has('additionalInfo')) {
            unselectedKeywords.push({ keyword: 'additionalInfo', count: null });
        }

        // Then add all keywords actually found in the schema
        if (this.keywordStats) {
            for (const { keyword, count } of this.keywordStats) {
                // Skip if already added or is a consolidated keyword
                if (!addedKeywords.has(keyword) && !this.consolidatedKeywords.has(keyword)) {
                    unselectedKeywords.push({ keyword, count });
                }
            }
        }

        // Sort unselected keywords by count (descending), with null values at the end
        unselectedKeywords.sort((a, b) => {
            if (a.count === null) return 1;
            if (b.count === null) return -1;
            return b.count - a.count;
        });

        // Add section separator if there are unselected items
        if (unselectedKeywords.length > 0 && this.selectedColumns.length > 0) {
            const separator = document.createElement('div');
            separator.style.borderTop = '2px solid #e9ecef';
            separator.style.margin = '10px 0';
            separator.style.padding = '10px 15px 5px';
            separator.style.fontSize = '12px';
            separator.style.color = '#718096';
            separator.style.fontWeight = '600';
            separator.textContent = 'Available Columns (sorted by usage):';
            checkboxList.appendChild(separator);
        }

        // Render unselected keywords
        for (const { keyword, count } of unselectedKeywords) {
            const def = this.getColumnDefinition(keyword);
            this.renderCheckboxItem(checkboxList, keyword, def.display, count, addedKeywords, -1, false);
        }
    }

    renderCheckboxItem(container, keyword, display, count, addedKeywords, index, isSelected) {
        if (addedKeywords.has(keyword)) return;
        addedKeywords.add(keyword);

        const item = document.createElement('div');
        const isMandatory = keyword === 'name';
        item.className = 'column-selector-item' + (isMandatory ? ' mandatory' : '');
        item.draggable = isSelected && !isMandatory; // Only selected non-mandatory items are draggable
        item.dataset.keyword = keyword;
        item.dataset.index = index >= 0 ? index : '';

        const countDisplay = count !== null ? `<span class="keyword-count">${count} properties</span>` : '';
        const dragHandle = (isSelected && !isMandatory) ? '<span class="drag-handle">⋮⋮</span>' :
                           (isSelected && isMandatory) ? '<span class="drag-handle" style="visibility: hidden;">⋮⋮</span>' : '';

        item.innerHTML = `
            ${dragHandle}
            <input type="checkbox"
                   class="column-selector-checkbox"
                   id="col-${keyword}"
                   value="${keyword}"
                   ${isSelected ? 'checked' : ''}
                   ${isMandatory ? 'disabled' : ''}>
            <label for="col-${keyword}" class="column-selector-label">
                <span class="keyword-name">${display}</span>
                ${countDisplay}
            </label>
        `;

        // Add drag event listeners if selected and not mandatory
        if (isSelected && !isMandatory) {
            this.addDragEventListeners(item);
        }

        container.appendChild(item);
    }

    addDragEventListeners(item) {
        item.addEventListener('dragstart', (e) => {
            this.draggedIndex = parseInt(item.dataset.index);
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/html', item.innerHTML);
        });

        item.addEventListener('dragend', (e) => {
            item.classList.remove('dragging');
            // Remove all drag-over classes
            document.querySelectorAll('.column-selector-item').forEach(el => {
                el.classList.remove('drag-over');
            });
        });

        item.addEventListener('dragover', (e) => {
            if (e.preventDefault) {
                e.preventDefault();
            }
            e.dataTransfer.dropEffect = 'move';

            const draggedItem = document.querySelector('.dragging');
            if (draggedItem && draggedItem !== item && item.draggable) {
                item.classList.add('drag-over');
            }

            return false;
        });

        item.addEventListener('dragleave', (e) => {
            item.classList.remove('drag-over');
        });

        item.addEventListener('drop', (e) => {
            if (e.stopPropagation) {
                e.stopPropagation();
            }

            const targetIndex = parseInt(item.dataset.index);
            if (this.draggedIndex !== null && targetIndex >= 0 && this.draggedIndex !== targetIndex) {
                this.moveColumn(this.draggedIndex, targetIndex);

                // Refresh the list to reflect new order
                const container = item.closest('.column-selector-container');
                this.refreshColumnList(container);

                // Update table
                if (window.currentData) {
                    const tableOutput = document.getElementById('tableOutput');
                    tableOutput.innerHTML = window.renderer.render(window.currentData, this.selectedColumns);
                }
            }

            item.classList.remove('drag-over');
            this.draggedIndex = null;

            return false;
        });
    }

    attachSelectorEvents(container) {
        const button = container.querySelector('#columnSelectorBtn');
        const list = container.querySelector('#columnSelectorList');
        const selectAllBtn = container.querySelector('#selectAllBtn');
        const selectNoneBtn = container.querySelector('#selectNoneBtn');
        const selectDefaultBtn = container.querySelector('#selectDefaultBtn');
        const resetOrderBtn = container.querySelector('#resetOrderBtn');

        // Toggle dropdown
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            list.classList.toggle('show');
            button.classList.toggle('open');
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!container.contains(e.target)) {
                list.classList.remove('show');
                button.classList.remove('open');
            }
        });

        // Select all
        selectAllBtn.addEventListener('click', () => {
            const allKeywords = new Set([...this.selectedColumns]);
            container.querySelectorAll('.column-selector-checkbox').forEach(cb => {
                if (!cb.checked) {
                    allKeywords.add(cb.value);
                }
                cb.checked = true;
            });
            this.selectedColumns = Array.from(allKeywords);
            this.refreshColumnList(container);
            this.updateTable(container);
        });

        // Select none
        selectNoneBtn.addEventListener('click', () => {
            // Always keep name column only
            this.selectedColumns = ['name'];
            this.refreshColumnList(container);
            this.updateTable(container);
        });

        // Select default
        selectDefaultBtn.addEventListener('click', () => {
            this.selectedColumns = this.defaultColumns.map(c => c.keyword);
            this.refreshColumnList(container);
            this.updateTable(container);
        });

        // Reset Order
        resetOrderBtn.addEventListener('click', () => {
            this.resetColumnOrder();
            this.refreshColumnList(container);
            this.updateTable(container);
        });

        // Handle individual checkbox changes using event delegation
        container.addEventListener('change', (e) => {
            if (e.target.classList.contains('column-selector-checkbox')) {
                this.handleCheckboxChange(e.target, container);
            }
        });
    }

    handleCheckboxChange(checkbox, container) {
        const keyword = checkbox.value;

        if (checkbox.checked) {
            // Add to selected columns if not already present
            if (!this.selectedColumns.includes(keyword)) {
                this.selectedColumns.push(keyword);
            }
        } else {
            // Remove from selected columns, but keep 'name' always
            if (keyword !== 'name') {
                this.selectedColumns = this.selectedColumns.filter(col => col !== keyword);
            } else {
                // Don't allow unchecking 'name' column
                checkbox.checked = true;
                return;
            }
        }

        this.refreshColumnList(container);
        this.updateTable(container);
    }

    updateTable(container) {
        // Update button text
        const button = container.querySelector('#columnSelectorBtn span:first-child');
        button.textContent = `${this.selectedColumns.length} columns selected`;

        // Update table
        if (window.currentData) {
            const tableOutput = document.getElementById('tableOutput');
            tableOutput.innerHTML = window.renderer.render(window.currentData, this.selectedColumns);
        }
    }

}

/**
 * Renders schema data as HTML tables and exports to CSV/Excel formats
 */
class TableRenderer {
    // Standard JSON Schema format descriptions
    static FORMAT_DESCRIPTIONS = {
        // Dates and Times
        'date-time': {
            description: 'Date and time together',
            example: '2018-11-13T20:20:39+00:00'
        },
        'time': {
            description: 'Time',
            example: '20:20:39+00:00'
        },
        'date': {
            description: 'Date',
            example: '2018-11-13'
        },
        'duration': {
            description: 'ISO 8601 duration',
            example: 'P3D (3 days)'
        },

        // Email Addresses
        'email': {
            description: 'Email address',
            example: 'user@example.com'
        },
        'idn-email': {
            description: 'Internationalized email',
            example: 'user@例え.jp'
        },

        // Hostnames
        'hostname': {
            description: 'Internet host name',
            example: 'example.com'
        },
        'idn-hostname': {
            description: 'Internationalized hostname',
            example: '例え.jp'
        },

        // IP Addresses
        'ipv4': {
            description: 'IPv4 address',
            example: '192.168.1.1'
        },
        'ipv6': {
            description: 'IPv6 address',
            example: '2001:db8::8a2e:370:7334'
        },

        // Resource Identifiers
        'uuid': {
            description: 'Universally Unique Identifier',
            example: '3e4666bf-d5e5-4aa7-b8ce-cefe41c7568a'
        },
        'uri': {
            description: 'URI',
            example: 'https://example.com/path'
        },
        'uri-reference': {
            description: 'URI or relative reference',
            example: '/path/to/resource'
        },
        'iri': {
            description: 'Internationalized URI',
            example: 'https://例え.jp/path'
        },
        'iri-reference': {
            description: 'Internationalized URI reference',
            example: '/パス/リソース'
        },

        // Templates and Pointers
        'uri-template': {
            description: 'URI Template',
            example: '/users/{id}/posts{?limit}'
        },
        'json-pointer': {
            description: 'JSON Pointer',
            example: '/foo/bar/0'
        },
        'relative-json-pointer': {
            description: 'Relative JSON Pointer',
            example: '0/foo/bar'
        },

        // Regular Expressions
        'regex': {
            description: 'Regular expression',
            example: '^[a-z]+$'
        }
    };

    constructor(columnManager) {
        this.columnManager = columnManager;
    }

    getFormatDescription(format) {
        return TableRenderer.FORMAT_DESCRIPTIONS[format] || null;
    }

    formatType(schema) {
        if (Array.isArray(schema.type)) {
            return schema.type.join(' | ');
        }
        return schema.type || 'any';
    }

    formatValue(value, isJson = false) {
        if (value === null || value === undefined) {
            return '';
        }

        if (typeof value === 'boolean') {
            return value ? 'true' : 'false';
        }

        if (typeof value === 'object') {
            const json = JSON.stringify(value, null, 2);
            if (json.length > 100) {
                return `<span class="cell-value-json" title="${this.escapeHtml(json)}">${this.escapeHtml(json.substring(0, 100))}...</span>`;
            }
            return `<span class="cell-value-json">${this.escapeHtml(json)}</span>`;
        }

        if (isJson) {
            return `<span class="cell-value-json">${this.escapeHtml(String(value))}</span>`;
        }

        return this.escapeHtml(String(value));
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Format constraint information from schema into an array of strings
     * @param {Object} prop - Property object with name and required flag
     * @param {Object} schema - JSON Schema object
     * @returns {Array<string>} Array of constraint strings
     */
    formatConstraintsColumn(prop, schema) {
        const constraints = [];

        // Add required status
        if (prop.required) {
            constraints.push('Required');
        }

        // Range constraints
        if (schema.minimum !== undefined || schema.maximum !== undefined ||
            schema.exclusiveMinimum !== undefined || schema.exclusiveMaximum !== undefined) {
            let min = '';
            let max = '';

            if (schema.minimum !== undefined) {
                min = schema.minimum;
            } else if (schema.exclusiveMinimum !== undefined) {
                min = `>${schema.exclusiveMinimum}`;
            }

            if (schema.maximum !== undefined) {
                max = schema.maximum;
            } else if (schema.exclusiveMaximum !== undefined) {
                max = `<${schema.exclusiveMaximum}`;
            }

            if (min !== '' || max !== '') {
                const rangeStr = min !== '' && max !== '' ? `${min}-${max}` : `${min}${max}`;
                constraints.push(`Range: ${rangeStr}`);
            }
        }

        // Length constraints
        if (schema.minLength !== undefined || schema.maxLength !== undefined) {
            if (schema.minLength === schema.maxLength) {
                constraints.push(`${schema.minLength} chars`);
            } else {
                const minLen = schema.minLength || '0';
                const maxLen = schema.maxLength || '∞';
                constraints.push(`${minLen}-${maxLen} chars`);
            }
        }

        // Pattern
        if (schema.pattern) {
            // Truncate long patterns
            const pattern = schema.pattern.length > 30 ?
                schema.pattern.substring(0, 30) + '...' : schema.pattern;
            constraints.push(`Pattern: ${pattern}`);
        }

        // Multiple of
        if (schema.multipleOf) {
            constraints.push(`Multiple of ${schema.multipleOf}`);
        }

        // Items constraints
        if (schema.minItems !== undefined || schema.maxItems !== undefined) {
            if (schema.minItems === schema.maxItems) {
                constraints.push(`${schema.minItems} items`);
            } else {
                const minItems = schema.minItems || '0';
                const maxItems = schema.maxItems || '∞';
                constraints.push(`${minItems}-${maxItems} items`);
            }
        }

        // Unique items
        if (schema.uniqueItems) {
            constraints.push('Unique items');
        }

        // Properties constraints
        if (schema.minProperties !== undefined || schema.maxProperties !== undefined) {
            if (schema.minProperties === schema.maxProperties) {
                constraints.push(`${schema.minProperties} properties`);
            } else {
                const minProps = schema.minProperties || '0';
                const maxProps = schema.maxProperties || '∞';
                constraints.push(`${minProps}-${maxProps} properties`);
            }
        }

        // Const value constraint
        if (schema.const !== undefined) {
            constraints.push(`Const: ${schema.const}`);
        }

        return constraints;
    }

    formatEnum(schema) {
        if (!schema.enum) return '';

        const hasDescriptions = schema.enumDescriptions &&
            Array.isArray(schema.enumDescriptions) &&
            schema.enumDescriptions.length === schema.enum.length;

        const enumId = 'enum_' + Math.random().toString(36).substr(2, 9);

        let html = `<div class="enum-container">
            <span class="enum-toggle" onclick="toggleEnum('${enumId}')">
                ${schema.enum.length} values ▼
            </span>
            <div id="${enumId}" class="enum-list">`;

        schema.enum.forEach((value, index) => {
            const desc = hasDescriptions ? schema.enumDescriptions[index] : '';
            html += `<div class="enum-item">
                <div class="enum-value">${this.escapeHtml(String(value))}</div>
                ${desc ? `<div class="enum-desc">${this.escapeHtml(desc)}</div>` : ''}
            </div>`;
        });

        html += `</div></div>`;
        return html;
    }

    formatCellValue(keyword, prop, schema) {
        switch (keyword) {
            case 'name':
                return `<span class="variable-name">${prop.name}</span>`;

            case 'description':
                return schema.description || '';

            case 'type':
                return `<span class="data-type">${this.formatType(schema)}</span>`;

            case 'enum':
                if (schema.const !== undefined) {
                    return `<span class="const-value">${this.escapeHtml(String(schema.const))}</span>`;
                }
                return this.formatEnum(schema);

            case 'constraints':
                const constraints = this.formatConstraintsColumn(prop, schema);
                return constraints.map(c => `<span class="constraint">${this.escapeHtml(c)}</span>`).join(' ');

            case 'default':
                return schema.default !== undefined ?
                    this.formatValue(schema.default, true) : '';

            case 'format':
                if (!schema.format) return '';

                const formatInfo = this.getFormatDescription(schema.format);
                if (formatInfo) {
                    // Built-in format with description
                    return `<div class="format-info">
                        <span class="format-name">${schema.format}</span>
                        <div class="format-details">
                            <span class="format-description">${formatInfo.description}</span>
                            <span class="format-example">e.g., ${this.escapeHtml(formatInfo.example)}</span>
                        </div>
                    </div>`;
                } else {
                    // Custom format
                    return `<div class="format-info">
                        <span class="format-name custom">${schema.format}</span>
                        <span class="format-custom-label">(custom)</span>
                    </div>`;
                }

            case 'deprecated':
            case 'readOnly':
            case 'writeOnly':
                return schema[keyword] === true ?
                    '<span class="required-badge">Yes</span>' : '';

            case 'title':
                return schema.title || '';

            case 'examples':
                if (schema.examples && Array.isArray(schema.examples)) {
                    return this.formatValue(schema.examples, true);
                }
                return '';

            case 'additionalInfo':
                return this.formatAdditionalInfo(prop, schema);

            default:
                // For any other keyword, display its value if it exists
                if (schema[keyword] !== undefined) {
                    return this.formatValue(schema[keyword]);
                }
                return '';
        }
    }

    formatAdditionalInfo(prop, schema) {
        // Get currently displayed columns
        const displayedColumns = this.columnManager.getSelectedColumns();

        // Collect all other keywords not in displayed columns or excluded
        const additionalData = {};
        for (const [key, value] of Object.entries(schema)) {
            if (!SchemaProcessor.EXCLUDED_KEYWORDS.has(key) &&
                !displayedColumns.includes(key) &&
                value !== undefined && value !== null) {
                additionalData[key] = value;
            }
        }

        if (Object.keys(additionalData).length === 0) {
            return '';
        }

        // Create a collapsible section for additional info
        const addId = 'add_' + Math.random().toString(36).substr(2, 9);
        const items = Object.entries(additionalData).map(([k, v]) => {
            let displayValue;
            if (typeof v === 'object') {
                displayValue = JSON.stringify(v, null, 2);
            } else {
                displayValue = String(v);
            }
            return `<div class="property"><strong>${this.columnManager.formatKeywordDisplay(k)}:</strong> ${this.escapeHtml(displayValue)}</div>`;
        }).join('');

        return `<span class="additional-info" onclick="toggleAdditional('${addId}')">
            ${Object.keys(additionalData).length} properties...
        </span>
        <div id="${addId}" class="additional-content">
            ${items}
        </div>`;
    }

    /**
     * Format enum values for export (CSV/Excel)
     * @param {Object} schema - The schema object
     * @param {string} format - Output format: 'csv' or 'excel'
     * @returns {string} Formatted enum values
     */
    formatEnumForExport(schema, format = 'csv') {
        if (!schema.enum) return '';

        const hasDescriptions = schema.enumDescriptions &&
            Array.isArray(schema.enumDescriptions) &&
            schema.enumDescriptions.length === schema.enum.length;

        const prefix = format === 'excel' ? '• ' : '';
        const separator = hasDescriptions ? ': ' : '';

        if (hasDescriptions) {
            return schema.enum.map((value, index) =>
                `${prefix}${value}${separator}${schema.enumDescriptions[index]}`
            ).join('\n');
        } else {
            return schema.enum.map(value => `${prefix}${value}`).join(format === 'excel' ? '\n' : '\n');
        }
    }

    /**
     * Format additional info for export (CSV/Excel)
     * @param {Object} prop - The property object
     * @param {Object} schema - The schema object
     * @returns {string} Formatted additional info
     */
    formatAdditionalInfoForExport(prop, schema) {
        // Get currently displayed columns
        const displayedColumns = this.columnManager.getSelectedColumns();

        // Collect all other keywords not in displayed columns or excluded
        const additionalData = [];
        for (const [key, value] of Object.entries(schema)) {
            if (!SchemaProcessor.EXCLUDED_KEYWORDS.has(key) &&
                !displayedColumns.includes(key) &&
                value !== undefined && value !== null) {
                const displayValue = typeof value === 'object' ?
                    JSON.stringify(value, null, 2) : String(value);
                additionalData.push(`${this.columnManager.formatKeywordDisplay(key)}: ${displayValue}`);
            }
        }

        return additionalData.join('\n');
    }

    /**
     * Render the data dictionary as an HTML table
     * @param {Object} data - Processed schema data with properties array
     * @param {Array<string>} selectedColumns - Optional array of column keywords to display
     * @returns {string} HTML string for the table
     */
    render(data, selectedColumns = null) {
        if (!data) return '<div class="error-message">No valid schema data to display</div>';

        const columns = selectedColumns || this.columnManager.getSelectedColumns();
        const hasCategories = data.properties.some(p => p.category);

        let html = `<div class="table-container">
            <div class="table-header">
                <div class="table-title">${data.title}</div>
                ${data.description ? `<div class="subtitle">${data.description}</div>` : ''}
            </div>
            <div class="search-box">
                <input type="text" class="search-input" id="searchInput"
                       placeholder="Search variables..." onkeyup="filterTable()">
            </div>
            <div class="table-scroll-wrapper">
                <table id="dataTable">
                    <thead>
                        <tr>`;

        // Add table headers for selected columns
        for (const col of columns) {
            const def = this.columnManager.getColumnDefinition(col);
            html += `<th class="col-${col}">${def.display}</th>`;
        }

        html += `</tr>
                    </thead>
                    <tbody>`;

        let lastCategory = null;
        for (const prop of data.properties) {
            // Add category row if changed
            if (hasCategories && prop.category && prop.category !== lastCategory) {
                html += `<tr class="category-row">
                    <td colspan="${columns.length}">${prop.category}</td>
                </tr>`;
                lastCategory = prop.category;
            }

            html += `<tr class="data-row">`;

            // Add cells for selected columns
            for (const col of columns) {
                const cellValue = this.formatCellValue(col, prop, prop.schema);
                html += `<td class="cell-${col}">${cellValue}</td>`;
            }

            html += `</tr>`;
        }

        html += `</tbody></table></div></div>`;
        return html;
    }

    exportToCSV(data, selectedColumns = null) {
        if (!data) return '';

        const columns = selectedColumns || this.columnManager.getSelectedColumns();
        const headers = ['Category'];

        // Add headers for selected columns
        for (const col of columns) {
            const def = this.columnManager.getColumnDefinition(col);
            headers.push(def.display);
        }

        const rows = [headers];

        let currentCategory = '';
        for (const prop of data.properties) {
            if (prop.category && prop.category !== currentCategory) {
                currentCategory = prop.category;
            }

            const row = [currentCategory || ''];

            // Add values for selected columns
            for (const col of columns) {
                let value = '';

                switch (col) {
                    case 'name':
                        value = prop.name;
                        break;
                    case 'description':
                        value = prop.schema.description || '';
                        break;
                    case 'type':
                        value = this.formatType(prop.schema);
                        break;
                    case 'enum':
                        value = prop.schema.const !== undefined ?
                            String(prop.schema.const) :
                            this.formatEnumForExport(prop.schema, 'csv');
                        break;
                    case 'format':
                        if (prop.schema.format) {
                            const formatInfo = this.getFormatDescription(prop.schema.format);
                            if (formatInfo) {
                                value = `${prop.schema.format} - ${formatInfo.description} (e.g., ${formatInfo.example})`;
                            } else {
                                value = `${prop.schema.format} (custom)`;
                            }
                        }
                        break;
                    case 'constraints':
                        value = this.formatConstraintsColumn(prop, prop.schema).join('\n');
                        break;
                    case 'additionalInfo':
                        value = this.formatAdditionalInfoForExport(prop, prop.schema);
                        break;
                    default:
                        if (prop.schema[col] !== undefined) {
                            value = JSON.stringify(prop.schema[col]);
                        }
                }

                row.push(value);
            }

            rows.push(row);
        }

        // Format for Excel with proper escaping
        return rows.map(row =>
            row.map(cell => {
                const cellStr = String(cell).replace(/"/g, '""');
                // Always quote cells that contain newlines, commas, or quotes
                if (cellStr.includes('\n') || cellStr.includes(',') || cellStr.includes('"')) {
                    return `"${cellStr}"`;
                }
                return cellStr;
            }).join(',')
        ).join('\n');
    }

    /**
     * Apply borders to a cell based on its position
     * @param {Object} cell - ExcelJS cell object
     * @param {number} rowIndex - Row index (1-based)
     */
    applyCellBorder(cell, rowIndex) {
        if (rowIndex === 1) {
            // Title row - thick border
            cell.border = {
                top: { style: 'medium', color: { argb: 'FF34495E' } },
                left: { style: 'medium', color: { argb: 'FF34495E' } },
                bottom: { style: 'medium', color: { argb: 'FF34495E' } },
                right: { style: 'medium', color: { argb: 'FF34495E' } }
            };
        } else if (rowIndex === 2) {
            // Header row - medium border
            cell.border = {
                top: { style: 'medium', color: { argb: 'FF34495E' } },
                left: { style: 'thin', color: { argb: 'FF95A5A6' } },
                bottom: { style: 'medium', color: { argb: 'FF34495E' } },
                right: { style: 'thin', color: { argb: 'FF95A5A6' } }
            };
        } else {
            // Data rows - thin border
            cell.border = {
                top: { style: 'thin', color: { argb: 'FFD5DBDB' } },
                left: { style: 'thin', color: { argb: 'FFD5DBDB' } },
                bottom: { style: 'thin', color: { argb: 'FFD5DBDB' } },
                right: { style: 'thin', color: { argb: 'FFD5DBDB' } }
            };
        }
    }

    async exportToExcel(data, selectedColumns = null) {
        if (!data) return;

        const columns = selectedColumns || this.columnManager.getSelectedColumns();

        // Create a new workbook
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'JSON Schema to Data Dictionary';
        workbook.created = new Date();

        // Add a worksheet
        const worksheet = workbook.addWorksheet(data.title || 'Data Dictionary', {
            properties: {
                defaultRowHeight: 18,
            },
            views: [
                {
                    state: 'frozen',
                    ySplit: 2,  // Freeze first 2 rows (title and headers)
                    activeCell: 'A3'
                }
            ]
        });

        // Add title row
        worksheet.mergeCells(`A1:${String.fromCharCode(65 + columns.length)}1`);
        const titleCell = worksheet.getCell('A1');
        titleCell.value = data.title || 'Data Dictionary';
        titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FF2C3E50' } };
        titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
        titleCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE8F4FD' }
        };
        worksheet.getRow(1).height = 30;

        // Add headers
        const headers = ['Category'];
        for (const col of columns) {
            const def = this.columnManager.getColumnDefinition(col);
            headers.push(def.display);
        }

        worksheet.addRow(headers);
        const headerRow = worksheet.getRow(2);
        headerRow.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF34495E' }
        };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        headerRow.height = 25;

        // Add filters
        worksheet.autoFilter = {
            from: { row: 2, column: 1 },
            to: { row: 2, column: headers.length }
        };

        // Process data rows
        let currentCategory = '';
        let rowIndex = 3;
        const hasCategories = data.properties.some(p => p.category);

        for (const prop of data.properties) {
            // Add category row if changed
            if (hasCategories && prop.category && prop.category !== currentCategory) {
                currentCategory = prop.category;
                worksheet.addRow([currentCategory]);
                const categoryRow = worksheet.getRow(rowIndex);
                worksheet.mergeCells(`A${rowIndex}:${String.fromCharCode(65 + columns.length)}${rowIndex}`);
                categoryRow.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF2C3E50' } };
                categoryRow.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFD5DBDB' }
                };
                categoryRow.alignment = { vertical: 'middle', horizontal: 'left' };
                categoryRow.height = 22;
                rowIndex++;
            }

            const rowData = [currentCategory || ''];

            // Add values for selected columns
            for (const col of columns) {
                let value = '';

                switch (col) {
                    case 'name':
                        value = prop.name;
                        break;
                    case 'description':
                        value = prop.schema.description || '';
                        break;
                    case 'type':
                        value = this.formatType(prop.schema);
                        break;
                    case 'enum':
                        value = prop.schema.const !== undefined ?
                            String(prop.schema.const) :
                            this.formatEnumForExport(prop.schema, 'excel');
                        break;
                    case 'format':
                        if (prop.schema.format) {
                            const formatInfo = this.getFormatDescription(prop.schema.format);
                            if (formatInfo) {
                                value = `${prop.schema.format}\n${formatInfo.description}\nExample: ${formatInfo.example}`;
                            } else {
                                value = `${prop.schema.format} (custom)`;
                            }
                        }
                        break;
                    case 'constraints':
                        value = this.formatConstraintsColumn(prop, prop.schema).join('\n');
                        break;
                    case 'additionalInfo':
                        value = this.formatAdditionalInfoForExport(prop, prop.schema);
                        break;
                    default:
                        if (prop.schema[col] !== undefined) {
                            value = typeof prop.schema[col] === 'object' ?
                                JSON.stringify(prop.schema[col], null, 2) :
                                String(prop.schema[col]);
                        }
                }

                rowData.push(value);
            }

            worksheet.addRow(rowData);
            const dataRow = worksheet.getRow(rowIndex);

            // Style data row
            dataRow.font = { name: 'Arial', size: 10 };
            dataRow.alignment = { vertical: 'top', wrapText: true };

            // Alternate row colors
            if ((rowIndex - 3) % 2 === 0) {
                dataRow.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFF8F9FA' }
                };
            }

            // Highlight required fields with bold (no red color)
            if (prop.required) {
                const nameCell = dataRow.getCell(columns.indexOf('name') + 2);
                nameCell.font = {
                    name: 'Arial',
                    size: 10,
                    bold: true
                };
            }

            // Set specific cell styles
            const typeCell = dataRow.getCell(columns.indexOf('type') + 2);
            if (typeCell.value) {
                typeCell.font = {
                    name: 'Consolas',
                    size: 10,
                    color: { argb: 'FF1976D2' }
                };
            }

            rowIndex++;
        }

        // Auto-fit columns with max width
        const maxWidthMap = {
            'description': 50,
            'enum': 35,
            'constraints': 30,
            'additionalInfo': 35
        };
        const defaultMaxWidth = 40;
        const categoryMaxWidth = 20;
        const minWidth = 10;

        worksheet.columns.forEach((column, index) => {
            let maxLength = 0;
            const columnLetter = String.fromCharCode(65 + index);

            // Check header length
            maxLength = Math.max(maxLength, headers[index]?.length || 0);

            // Check all data in the column
            for (let i = 3; i <= worksheet.rowCount; i++) {
                const cell = worksheet.getCell(`${columnLetter}${i}`);
                const cellValue = String(cell.value || '');
                // For multi-line content, check the longest line
                const lines = cellValue.split('\n');
                const longestLine = Math.max(...lines.map(line => line.length));
                maxLength = Math.max(maxLength, longestLine);
            }

            // Determine max width based on column type
            let maxWidth;
            if (index === 0) {
                maxWidth = categoryMaxWidth;
            } else {
                const columnKey = columns[index - 1];
                maxWidth = maxWidthMap[columnKey] || defaultMaxWidth;
            }

            column.width = Math.min(Math.max(maxLength + 2, minWidth), maxWidth);
        });

        // Add borders to all cells
        for (let i = 1; i <= worksheet.rowCount; i++) {
            for (let j = 1; j <= headers.length; j++) {
                const cell = worksheet.getRow(i).getCell(j);
                this.applyCellBorder(cell, i);
            }
        }

        // Set page setup for printing
        worksheet.pageSetup = {
            orientation: 'landscape',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
            margins: {
                left: 0.7,
                right: 0.7,
                top: 0.75,
                bottom: 0.75,
                header: 0.3,
                footer: 0.3
            }
        };

        // Generate Excel file
        const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });

        // Download file
        saveAs(blob, `${data.title || 'data_dictionary'}.xlsx`);
    }

}

// Global functions for event handlers
window.toggleEnum = function(id) {
    const element = document.getElementById(id);
    element.classList.toggle('show');
};

window.toggleAdditional = function(id) {
    const element = document.getElementById(id);
    element.classList.toggle('show');
};

window.filterTable = function() {
    const input = document.getElementById('searchInput');
    const filter = input.value.toLowerCase();
    const rows = document.querySelectorAll('#dataTable tbody .data-row');

    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        if (text.includes(filter)) {
            row.classList.remove('hidden');
        } else {
            row.classList.add('hidden');
        }
    });
};

// Initialize
const processor = new SchemaProcessor();
const columnManager = new ColumnManager();
const renderer = new TableRenderer(columnManager);

// Make components globally accessible for event handlers
window.renderer = renderer;
window.currentData = null;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('fileInput').addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        const fileInfo = document.getElementById('fileInfo');
        const processBtn = document.getElementById('processBtn');
        const errorMessage = document.getElementById('errorMessage');

        const clearBtn = document.getElementById('clearBtn');
        if (files.length === 0) {
            fileInfo.textContent = 'No files selected';
            processBtn.style.display = 'none';
            clearBtn.style.display = 'none';
            return;
        }

        fileInfo.textContent = files.length === 1 ?
            files[0].name :
            `${files.length} files selected`;

        processBtn.style.display = 'inline-block';
        clearBtn.style.display = 'inline-block';
        errorMessage.innerHTML = '';
    });

    document.getElementById('processBtn').addEventListener('click', async () => {
        const files = Array.from(document.getElementById('fileInput').files);
        const errorMessage = document.getElementById('errorMessage');
        const tableOutput = document.getElementById('tableOutput');
        const exportBtn = document.getElementById('exportBtn');
        const columnSelectorContainer = document.getElementById('columnSelectorContainer');

        try {
            tableOutput.innerHTML = '<div class="loading">Processing schemas...</div>';

            const success = await processor.processFiles(files);

            if (!success) {
                throw new Error('Could not identify main schema. Please ensure one schema has type: "array" with items.');
            }

            window.currentData = processor.getTableData();

            // Get keyword usage statistics
            const keywordStats = processor.getKeywordUsageStats();

            // Render column selector
            columnSelectorContainer.innerHTML = '';
            columnSelectorContainer.appendChild(columnManager.renderColumnSelector(keywordStats));
            columnSelectorContainer.style.display = 'block';

            // Render table with default columns
            tableOutput.innerHTML = renderer.render(currentData);
            exportBtn.style.display = 'inline-block';

        } catch (error) {
            errorMessage.innerHTML = `<div class="error-message">Error: ${error.message}</div>`;
            tableOutput.innerHTML = '';
            exportBtn.style.display = 'none';
            columnSelectorContainer.style.display = 'none';
        }
    });

    document.getElementById('exportBtn').addEventListener('click', async () => {
        if (!currentData) return;

        try {
            const exportBtn = document.getElementById('exportBtn');
            const originalText = exportBtn.textContent;

            // Show loading state
            exportBtn.disabled = true;
            exportBtn.textContent = 'Generating Excel...';

            // Generate Excel file
            await renderer.exportToExcel(currentData, columnManager.getSelectedColumns());

            // Restore button state
            exportBtn.disabled = false;
            exportBtn.textContent = originalText;
        } catch (error) {
            console.error('Error generating Excel file:', error);
            alert('An error occurred while generating the Excel file. Please try again.');

            // Restore button state
            const exportBtn = document.getElementById('exportBtn');
            exportBtn.disabled = false;
            exportBtn.textContent = 'Export to Excel';
        }
    });

    // Clear button handler
    document.getElementById('clearBtn').addEventListener('click', () => {
        // Clear all displays
        document.getElementById('tableOutput').innerHTML = '';
        document.getElementById('columnSelectorContainer').innerHTML = '';
        document.getElementById('columnSelectorContainer').style.display = 'none';
        document.getElementById('errorMessage').innerHTML = '';

        // Reset file input
        document.getElementById('fileInput').value = '';
        document.getElementById('fileInfo').textContent = 'No files selected';

        // Hide buttons
        document.getElementById('processBtn').style.display = 'none';
        document.getElementById('clearBtn').style.display = 'none';
        document.getElementById('exportBtn').style.display = 'none';

        // Clear processor data
        processor.schemas.clear();
        processor.mainSchema = null;
        processor.keywordUsage.clear();

        // Clear current data
        window.currentData = null;

        // Reset column manager to defaults
        columnManager.selectedColumns = [...columnManager.defaultColumnOrder];
    });

    // Close enum dropdowns when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.classList.contains('enum-toggle')) {
            document.querySelectorAll('.enum-list.show').forEach(el => {
                el.classList.remove('show');
            });
        }
    });
});