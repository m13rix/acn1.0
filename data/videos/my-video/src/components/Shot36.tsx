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

export const Shot36: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 9.41s total
	// Original: 0-8s (Balancing), 8-12s (Stable) -> 8/12 = 2/3 split approx
	const splitFrame = Math.round((8 / 12) * durationInFrames);

	// Scales Balancing Animation (Oscillation dampening)
	const balanceProgress = interpolate(
		frame,
		[0, splitFrame],
		[0, 1],
		{extrapolateRight: 'clamp', easing: Easing.out(Easing.quad)}
	);

	const oscillation = Math.sin(frame * 0.15) * 10 * (1 - balanceProgress);
	const rotation = oscillation; // Tilt of the scales

	// Scale pan/zoom
	const zoom = interpolate(frame, [0, durationInFrames], [1, 1.1]);

	// Text Labels 'Свобода' and 'Защита'
	const labelOpacity = interpolate(frame, [0, 20], [0, 1], {extrapolateRight: 'clamp'});

	return (
		<AbsoluteFill style={{backgroundColor: '#fdfdf5'}}>
			{/* Main Background Image */}
			<AbsoluteFill
				style={{
					transform: `scale(${zoom})`,
				}}
			>
				<Img
					src={staticFile('balance_freedom_protection.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'sepia(0.1) contrast(1.05)', // Symbolic legal art style
					}}
				/>
			</AbsoluteFill>

			{/* Animated Scale Effect (Overlay) */}
			<AbsoluteFill className="justify-center items-center">
				<div 
					className="relative w-full h-full flex justify-center items-center"
					style={{transform: `rotate(${rotation}deg)`}}
				>
					{/* Left Label */}
					<div 
						className="absolute left-1/4 top-1/3 bg-white/60 px-6 py-2 border-2 border-gray-400"
						style={{opacity: labelOpacity, transform: `rotate(${-rotation}deg)`}}
					>
						<span className="text-gray-800 text-3xl font-bold uppercase tracking-widest">Свобода</span>
					</div>
					{/* Right Label */}
					<div 
						className="absolute right-1/4 top-1/3 bg-white/60 px-6 py-2 border-2 border-gray-400"
						style={{opacity: labelOpacity, transform: `rotate(${-rotation}deg)`}}
					>
						<span className="text-gray-800 text-3xl font-bold uppercase tracking-widest">Защита</span>
					</div>
				</div>
			</AbsoluteFill>

			{/* Fulcrum Focus Glow (Center protection) */}
			<AbsoluteFill className="justify-center items-center">
				<div 
					className="w-64 h-64 rounded-full"
					style={{
						background: 'radial-gradient(circle, rgba(255, 215, 0, 0.2) 0%, transparent 70%)',
						opacity: balanceProgress,
					}}
				/>
			</AbsoluteFill>

			{/* Border Frame */}
			<AbsoluteFill 
				style={{
					border: '20px solid rgba(100, 80, 50, 0.1)',
					pointerEvents: 'none',
				}}
			/>

			<Audio src={staticFile('shot36_voice.mp3')} />
		</AbsoluteFill>
	);
};
