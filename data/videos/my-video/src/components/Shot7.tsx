import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import React from 'react';

export const Shot7: React.FC = () => {
	const frame = useCurrentFrame();
	const {fps, durationInFrames} = useVideoConfig();

	// Timeline scaling: 9.07s total
	// Segments approx 3s each
	const segment1End = Math.round((5 / 15) * durationInFrames); // ~3.02s
	const segment2End = Math.round((10 / 15) * durationInFrames); // ~6.05s
	
	// 1. Tree Diagram Appearance (Fade in + slight scale up)
	const treeOpacity = interpolate(frame, [0, fps], [0, 1], {
		extrapolateRight: 'clamp',
	});
	const treeScale = interpolate(frame, [0, durationInFrames], [1, 1.05], {
		extrapolateRight: 'clamp',
	});

	// 2. Red Prohibition Signs (Parents-Children)
	// Assume central vertical line positions based on generic tree structure
	const prohibitionStart = segment1End;
	const prohibitionOpacity = interpolate(frame, [prohibitionStart, prohibitionStart + 10], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});
	const prohibitionScale = interpolate(frame, [prohibitionStart, prohibitionStart + 10], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
		easing: Easing.back(1.5), // Pop effect
	});

	// 3. Green Checkmarks (Cousins - side branches)
	const checkmarkStart = segment2End;
	const checkmarkOpacity = interpolate(frame, [checkmarkStart, checkmarkStart + 10], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});
	const checkmarkScale = interpolate(frame, [checkmarkStart, checkmarkStart + 10], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
		easing: Easing.back(1.5),
	});

	// Mock positions for overlays (assuming a standard tree layout in the image)
	const prohibitions = [
		{x: '50%', y: '30%'}, // Parent
		{x: '50%', y: '70%'}, // Child
	];

	const checkmarks = [
		{x: '20%', y: '50%'}, // Cousin Left
		{x: '80%', y: '50%'}, // Cousin Right
	];

	return (
		<AbsoluteFill style={{backgroundColor: 'white'}}>
			{/* Tree Diagram */}
			<AbsoluteFill
				style={{
					opacity: treeOpacity,
					transform: `scale(${treeScale})`,
				}}
			>
				<Img
					src={staticFile('family_tree_prohibition.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'contain', // Changed to contain to see full chart
					}}
				/>
			</AbsoluteFill>

			{/* Prohibition Signs */}
			{prohibitions.map((pos, i) => (
				<AbsoluteFill
					key={`stop-${i}`}
					style={{
						left: pos.x,
						top: pos.y,
						width: 150,
						height: 150,
						transform: `translate(-50%, -50%) scale(${prohibitionScale})`,
						opacity: prohibitionOpacity,
						justifyContent: 'center',
						alignItems: 'center',
					}}
				>
					{/* CSS Circle with Cross */}
					<div
						style={{
							width: '100%',
							height: '100%',
							borderRadius: '50%',
							border: '15px solid #cc0000',
							position: 'relative',
							backgroundColor: 'rgba(255, 255, 255, 0.8)',
						}}
					>
						<div
							style={{
								position: 'absolute',
								top: '50%',
								left: '0',
								width: '100%',
								height: '15px',
								backgroundColor: '#cc0000',
								transform: 'translateY(-50%) rotate(45deg)',
							}}
						/>
					</div>
				</AbsoluteFill>
			))}

			{/* Green Checkmarks */}
			{checkmarks.map((pos, i) => (
				<AbsoluteFill
					key={`check-${i}`}
					style={{
						left: pos.x,
						top: pos.y,
						width: 150,
						height: 150,
						transform: `translate(-50%, -50%) scale(${checkmarkScale})`,
						opacity: checkmarkOpacity,
						justifyContent: 'center',
						alignItems: 'center',
					}}
				>
					{/* CSS Checkmark */}
					<div
						style={{
							width: '100%',
							height: '100%',
							borderRadius: '50%',
							border: '10px solid #00cc00',
							backgroundColor: 'rgba(255, 255, 255, 0.8)',
							display: 'flex',
							justifyContent: 'center',
							alignItems: 'center',
						}}
					>
						<div
							style={{
								width: '60%',
								height: '35%',
								borderLeft: '15px solid #00cc00',
								borderBottom: '15px solid #00cc00',
								transform: 'translateY(-10%) rotate(-45deg)',
							}}
						/>
					</div>
				</AbsoluteFill>
			))}

			<Audio src={staticFile('shot7_voice.mp3')} />
		</AbsoluteFill>
	);
};
